import type { Config } from '@pelp/domain';
import { CURRENT_CONSENT_TEXT_VERSION, ConfigSchema, defaultConfig } from '@pelp/domain';
import type { Store } from './store';

export interface ConfigSource {
  get(): Promise<Config>;
  invalidate(): void;
}

/**
 * Config global con caché de 60 s (sección 13). Si no existe en la tabla, siembra la
 * versión 1 por defecto: `cdk deploy` desde cero deja un sistema funcional.
 * Los ids de recursos vacíos en la config se completan desde variables de entorno.
 */
export class ConfigProvider implements ConfigSource {
  private cached?: { config: Config; at: number };

  constructor(
    private readonly store: Store,
    private readonly ttlMs = 60_000,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async get(): Promise<Config> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.config;
    let record = await this.store.getConfigRecord();
    if (!record) {
      record = await this.store.putConfig(defaultConfig(CURRENT_CONSENT_TEXT_VERSION, this.env.TERMS_URL ?? '/terminos'), 'system', 'seed inicial');
    }
    const parsed = ConfigSchema.safeParse(record.config);
    if (!parsed.success) {
      // Nunca silencioso: si la config guardada no valida, el motor sigue con los defaults y lo dice.
      console.warn(JSON.stringify({ level: 'warn', message: 'config.invalid_fallback_defaults', version: record.version, issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`) }));
    }
    const base = parsed.success ? parsed.data : defaultConfig(CURRENT_CONSENT_TEXT_VERSION, this.env.TERMS_URL ?? '/terminos');
    const config = this.applyEnv(base);
    this.cached = { config, at: Date.now() };
    return config;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private applyEnv(config: Config): Config {
    const env = this.env;
    return {
      ...config,
      corpus: {
        ...config.corpus,
        knowledgeBaseId: config.corpus.knowledgeBaseId || env.KNOWLEDGE_BASE_ID || '',
        dataSourceId: config.corpus.dataSourceId || env.DATA_SOURCE_ID || '',
      },
      guardrails: {
        ...config.guardrails,
        bedrockGuardrailId: config.guardrails.bedrockGuardrailId || env.GUARDRAIL_ID || '',
        bedrockGuardrailVersion: config.guardrails.bedrockGuardrailVersion || env.GUARDRAIL_VERSION || '',
      },
      consent: {
        ...config.consent,
        termsUrl: config.consent.termsUrl || env.TERMS_URL || '/terminos',
      },
    };
  }
}

/** Fuente fija para tests. */
export class StaticConfig implements ConfigSource {
  constructor(public config: Config) {}
  async get(): Promise<Config> {
    return this.config;
  }
  invalidate(): void {}
}
