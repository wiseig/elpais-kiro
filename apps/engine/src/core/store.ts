import type {
  Answer,
  AuditRecord,
  BiasReportRecord,
  BlockRecord,
  CacheRecord,
  ChannelsRecord,
  ClickRecord,
  Config,
  ConfigRecord,
  ConsentRecord,
  ConversationRecord,
  ConversationTurn,
  CorpusDayRecord,
  CorpusIndexRecord,
  CostRecord,
  EvalCaseRecord,
  EvalRunRecord,
  IdentityRecord,
  IncidentRecord,
  Key,
  MessageRecord,
  QuestionLogRecord,
  RateLimitRecord,
  ReaderProfile,
  ReaderRecord,
  SyncRunRecord,
  TokenUsage,
} from '@pelp/domain';
import { keys, montevideoDay, splitSk, ulid, ulidTime } from '@pelp/domain';
import type { Db } from './db';

const DAY = 86_400;

export function ttlAfterSeconds(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000) + seconds;
}

/** ISO derivado del ULID: permite reconstruir el SK `Q#<ts>#<id>` a partir del id. */
export function isoFromUlid(id: string): string {
  return new Date(ulidTime(id)).toISOString();
}

export interface InboundReceipt extends Key {
  type: 'InboundReceipt';
  state: 'processing' | 'processed' | 'published';
  answer?: Answer;
  expiresAt: number;
}

function inboundReceiptKey(channel: string, requestId: string): Key {
  return { PK: `${keys.tenantPrefix}#INBOUND#${channel}`, SK: `REQUEST#${requestId}` };
}

/**
 * Operaciones de dominio sobre la tabla única `pelp-main` (sección 12).
 * Lo comparten el motor, la admin-api y los jobs.
 */
export class Store {
  constructor(readonly db: Db) {}

  /* ----------------------- Idempotencia de canales ---------------------- */

  async getInboundReceipt(channel: string, requestId: string): Promise<InboundReceipt | undefined> {
    return this.db.get<InboundReceipt>(inboundReceiptKey(channel, requestId));
  }

  async claimInbound(channel: string, requestId: string, now: Date): Promise<boolean> {
    return this.db.put({
      ...inboundReceiptKey(channel, requestId),
      type: 'InboundReceipt',
      state: 'processing',
      expiresAt: ttlAfterSeconds(now, 7 * DAY),
    } satisfies InboundReceipt, { ifNotExists: true });
  }

  async saveInboundResult(channel: string, requestId: string, answer: Answer): Promise<void> {
    await this.db.update(inboundReceiptKey(channel, requestId), { set: { state: 'processed', answer }, mustExist: true });
  }

  async markInboundPublished(channel: string, requestId: string): Promise<void> {
    await this.db.update(inboundReceiptKey(channel, requestId), { set: { state: 'published' }, mustExist: true });
  }

  async releaseInbound(channel: string, requestId: string): Promise<void> {
    await this.db.delete(inboundReceiptKey(channel, requestId));
  }

  /* ----------------------------- Config ----------------------------- */

  async getConfigRecord(): Promise<ConfigRecord | undefined> {
    return this.db.get<ConfigRecord>(keys.config());
  }

  async putConfig(config: Config, updatedBy: string, reason?: string): Promise<ConfigRecord> {
    const current = await this.getConfigRecord();
    const version = (current?.version ?? 0) + 1;
    const now = new Date().toISOString();
    const record: ConfigRecord = {
      ...keys.config(),
      type: 'Config',
      config: { ...config, version },
      version,
      updatedAt: now,
      updatedBy,
      ...(reason ? { reason } : {}),
    };
    await this.db.put({ ...record, ...keys.configVersion(version) });
    await this.db.put(record);
    return record;
  }

  async listConfigVersions(limit = 50): Promise<ConfigRecord[]> {
    return this.db.query<ConfigRecord>({ pk: keys.config().PK, skPrefix: 'V#', scanForward: false, limit });
  }

  async getConfigVersion(version: number): Promise<ConfigRecord | undefined> {
    return this.db.get<ConfigRecord>(keys.configVersion(version));
  }

  /* ----------------------------- Lectores ----------------------------- */

  async getReader(readerId: string): Promise<ReaderRecord | undefined> {
    const reader = await this.db.get<ReaderRecord>(keys.reader(readerId));
    return reader && !reader.deleted ? reader : undefined;
  }

  async findReaderIdByIdentity(channel: string, hash: string): Promise<string | undefined> {
    const identity = await this.db.get<IdentityRecord>(keys.identity(channel, hash));
    return identity?.readerId;
  }

  async createReader(channel: string, hash: string, now: Date, textVersion: string): Promise<ReaderRecord> {
    const readerId = ulid(now.getTime());
    const at = now.toISOString();
    const profile: ReaderProfile = {
      readerId,
      tenantId: 'el-pais',
      terms: { accepted: false, version: textVersion, at: '' },
      consent: { personalization: false, sensitiveInference: false, version: textVersion },
      topics: [],
      frames: [],
      style: { length: 'media', dataAffinity: 'media', tone: 'directo' },
      evidenceCount: 0,
      updatedAt: at,
      version: 0,
    };
    const reader: ReaderRecord = {
      ...keys.reader(readerId),
      type: 'Reader',
      profile,
      lastChannel: channel,
      lastActivityAt: at,
      createdAt: at,
      questionCount: 0,
      questionsSinceProfile: 0,
      identities: [{ channel, hash }],
      GSI1PK: keys.gsi1Channel(channel),
      GSI1SK: at,
    };
    const identity: IdentityRecord = { ...keys.identity(channel, hash), type: 'Identity', readerId, channel, createdAt: at };
    const created = await this.db.put(identity, { ifNotExists: true });
    if (!created) {
      const existing = await this.findReaderIdByIdentity(channel, hash);
      const record = existing ? await this.getReader(existing) : undefined;
      if (record) return record;
    }
    await this.db.put(reader);
    return reader;
  }

  async saveReader(reader: ReaderRecord): Promise<void> {
    await this.db.put({ ...reader, GSI1PK: keys.gsi1Channel(reader.lastChannel), GSI1SK: reader.lastActivityAt });
  }

  async touchReader(readerId: string, channel: string, now: Date, increments: { questions?: number }): Promise<ReaderRecord | undefined> {
    const at = now.toISOString();
    const updated = await this.db.update(keys.reader(readerId), {
      set: { lastActivityAt: at, lastChannel: channel, GSI1PK: keys.gsi1Channel(channel), GSI1SK: at },
      add: increments.questions ? { questionCount: increments.questions, questionsSinceProfile: increments.questions } : {},
      mustExist: true,
    });
    return updated as ReaderRecord | undefined;
  }

  async listReadersByChannel(channel: string, limit = 100): Promise<ReaderRecord[]> {
    const rows = await this.db.query<ReaderRecord>({ index: 'GSI1', pk: keys.gsi1Channel(channel), scanForward: false, limit: limit * 2 });
    return rows.filter((row) => row.type === 'Reader' && !row.deleted).slice(0, limit);
  }

  async putProfileVersion(readerId: string, profile: ReaderProfile, now: Date): Promise<void> {
    await this.db.put({ ...keys.profileVersion(readerId, now.toISOString()), type: 'ProfileVersion', profile });
  }

  async listProfileVersions(readerId: string, limit = 20): Promise<{ SK: string; profile: ReaderProfile }[]> {
    return this.db.query({ pk: keys.readerPk(readerId), skPrefix: 'PROFILEV#', scanForward: false, limit });
  }

  async deleteProfileVersions(readerId: string): Promise<void> {
    const rows = await this.db.query<Key>({ pk: keys.readerPk(readerId), skPrefix: 'PROFILEV#', all: true });
    await this.db.batchDelete(rows.map((row) => ({ PK: row.PK, SK: row.SK })));
  }

  /* --------------------------- Consentimiento --------------------------- */

  async putConsent(readerId: string, record: Omit<ConsentRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.consent(readerId, record.at), type: 'Consent', ...record });
  }

  async listConsents(readerId: string): Promise<ConsentRecord[]> {
    return this.db.query<ConsentRecord>({ pk: keys.readerPk(readerId), skPrefix: 'CONSENT#', all: true });
  }

  /** Lápida anónima al borrar (8.4): versión del texto y fecha, sin identificador. */
  async putConsentTombstone(textVersion: string, channel: string, now: Date): Promise<void> {
    await this.db.put({
      PK: `${keys.tenantPrefix}#CONSENT-TOMBSTONE`,
      SK: `${now.toISOString()}#${ulid(now.getTime()).slice(-6)}`,
      type: 'Consent',
      decision: 'delete',
      textVersion,
      channel,
      at: now.toISOString(),
      tombstone: true,
    } satisfies ConsentRecord);
  }

  /* --------------------------- Conversaciones --------------------------- */

  async getConversation(readerId: string, convId: string): Promise<ConversationRecord | undefined> {
    const rows = await this.db.query<ConversationRecord>({ pk: keys.readerPk(readerId), skPrefix: 'CONV#' , all: true });
    return rows.find((row) => row.convId === convId);
  }

  async listConversations(readerId: string): Promise<ConversationRecord[]> {
    return this.db.query<ConversationRecord>({ pk: keys.readerPk(readerId), skPrefix: 'CONV#', all: true });
  }

  async saveConversation(readerId: string, conversation: ConversationRecord & { turnsData?: ConversationTurn[] }, now: Date, ttlSeconds: number): Promise<void> {
    await this.db.put({ ...conversation, expiresAt: ttlAfterSeconds(now, ttlSeconds) });
  }

  newConversation(readerId: string, channel: string, now: Date): ConversationRecord & { turnsData: ConversationTurn[] } {
    const convId = ulid(now.getTime());
    const at = now.toISOString();
    return { ...keys.conversation(readerId, at, convId), type: 'Conversation', convId, channel, startedAt: at, lastAt: at, turns: 0, turnsData: [] };
  }

  async putMessage(record: Omit<MessageRecord, 'PK' | 'SK' | 'type'>, ttlSeconds: number, now: Date): Promise<void> {
    await this.db.put({ ...keys.message(record.convId, record.at, record.msgId), type: 'Message', ...record, expiresAt: ttlAfterSeconds(now, ttlSeconds) });
  }

  async listMessages(convId: string): Promise<MessageRecord[]> {
    return this.db.query<MessageRecord>({ pk: keys.conversationPk(convId), skPrefix: 'MSG#', all: true });
  }

  async getMessage(convId: string, msgId: string): Promise<MessageRecord | undefined> {
    return this.db.get<MessageRecord>(keys.message(convId, isoFromUlid(msgId), msgId));
  }

  /* --------------------------- Log de preguntas --------------------------- */

  async putQuestionLog(record: Omit<QuestionLogRecord, 'PK' | 'SK' | 'type' | 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK'>): Promise<void> {
    await this.db.put({
      ...keys.questionLog(record.day, record.at, record.msgId),
      type: 'QuestionLog',
      ...record,
      GSI1PK: keys.gsi1Channel(record.channel),
      GSI1SK: record.at,
      GSI2PK: keys.gsi2Qnorm(record.qnormHash),
      GSI2SK: record.at,
    });
  }

  questionLogKey(msgId: string): Key {
    const at = isoFromUlid(msgId);
    return keys.questionLog(montevideoDay(new Date(at)), at, msgId);
  }

  async getQuestionLog(msgId: string): Promise<QuestionLogRecord | undefined> {
    return this.db.get<QuestionLogRecord>(this.questionLogKey(msgId));
  }

  async updateQuestionLog(msgId: string, set: Record<string, unknown>, remove?: string[]): Promise<void> {
    try {
      await this.db.update(this.questionLogKey(msgId), { set, remove, mustExist: true });
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  async listQuestionLogs(day: string, limit?: number): Promise<QuestionLogRecord[]> {
    return this.db.query<QuestionLogRecord>({ pk: keys.dayPk(day), skPrefix: 'Q#', scanForward: false, all: !limit, ...(limit ? { limit } : {}) });
  }

  async listQuestionLogsByQnorm(qnormHash: string, limit = 50): Promise<QuestionLogRecord[]> {
    return this.db.query<QuestionLogRecord>({ index: 'GSI2', pk: keys.gsi2Qnorm(qnormHash), scanForward: false, limit });
  }

  /* ------------------------------- Caché ------------------------------- */

  async getCache(questionHash: string, corpusVersion: string, now = new Date()): Promise<CacheRecord | undefined> {
    const record = await this.db.get<CacheRecord>(keys.cache(questionHash, corpusVersion));
    if (record?.expiresAt && record.expiresAt < Math.floor(now.getTime() / 1000)) return undefined;
    return record;
  }

  async putCache(questionHash: string, corpusVersion: string, record: Omit<CacheRecord, 'PK' | 'SK' | 'type' | 'expiresAt' | 'hits'>, ttlMinutes: number, now: Date): Promise<void> {
    if (ttlMinutes <= 0) return;
    await this.db.put({ ...keys.cache(questionHash, corpusVersion), type: 'Cache', ...record, hits: 0, expiresAt: ttlAfterSeconds(now, ttlMinutes * 60) });
  }

  async bumpCacheHit(questionHash: string, corpusVersion: string): Promise<void> {
    await this.db.update(keys.cache(questionHash, corpusVersion), { add: { hits: 1 } }).catch(() => undefined);
  }

  /* ----------------------------- Rate limit ----------------------------- */

  async incrementRateLimit(readerId: string, hourKeyValue: string, now: Date): Promise<number> {
    const updated = await this.db.update(keys.rateLimit(readerId, hourKeyValue), {
      set: { type: 'RateLimit', expiresAt: ttlAfterSeconds(now, 2 * 3600) },
      add: { count: 1 },
    });
    return ((updated as RateLimitRecord | undefined)?.count ?? 1) as number;
  }

  /* ------------------------- Bloqueos e incidentes ------------------------- */

  async putBlock(record: Omit<BlockRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.block(montevideoDay(new Date(record.at)), record.at, record.id), type: 'Block', ...record, GSI1PK: keys.gsi1Channel(record.channel), GSI1SK: record.at });
  }

  async listBlocks(day: string): Promise<BlockRecord[]> {
    return this.db.query<BlockRecord>({ pk: keys.dayPk(day), skPrefix: 'BLOCK#', scanForward: false, all: true });
  }

  async putIncident(record: Omit<IncidentRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.incident(montevideoDay(new Date(record.at)), record.at, record.id), type: 'Incident', ...record });
  }

  async listIncidents(day: string): Promise<IncidentRecord[]> {
    return this.db.query<IncidentRecord>({ pk: keys.dayPk(day), skPrefix: 'INCIDENT#', scanForward: false, all: true });
  }

  /* -------------------------------- Clics -------------------------------- */

  async putClick(readerId: string, record: Omit<ClickRecord, 'PK' | 'SK' | 'type'>, now: Date): Promise<void> {
    await this.db.put({ ...keys.click(readerId, record.at, record.id), type: 'Click', ...record, expiresAt: ttlAfterSeconds(now, 90 * DAY) });
  }

  async listClicks(readerId: string, limit = 100): Promise<ClickRecord[]> {
    return this.db.query<ClickRecord>({ pk: keys.readerPk(readerId), skPrefix: 'CLICK#', scanForward: false, limit });
  }

  /* -------------------------------- Costos -------------------------------- */

  async addCost(day: string, model: string, usage: TokenUsage, costUsd: number, channel: string): Promise<void> {
    await this.db.update(keys.cost(day, model), {
      set: { type: 'Cost', day, model },
      add: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        calls: 1,
        costUsd,
        [`byChannel.${channel}`]: costUsd,
      },
    }).catch(async (error: unknown) => {
      // Rutas anidadas en ADD requieren que el mapa exista; reintento sin el desglose por canal.
      if ((error as { name?: string }).name === 'ValidationException') {
        await this.db.update(keys.cost(day, model), {
          set: { type: 'Cost', day, model },
          add: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, calls: 1, costUsd },
        });
        return;
      }
      throw error;
    });
  }

  async listCosts(day: string): Promise<CostRecord[]> {
    return this.db.query<CostRecord>({ pk: keys.cost(day, '').PK, skPrefix: `DAY#${day}#`, all: true });
  }

  /* -------------------------------- Corpus -------------------------------- */

  async getCorpusIndex(articleId: string): Promise<CorpusIndexRecord | undefined> {
    return this.db.get<CorpusIndexRecord>(keys.corpus(articleId));
  }

  async putCorpusIndex(record: Omit<CorpusIndexRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.corpus(record.articleId), type: 'CorpusIndex', ...record, GSI1PK: `${keys.tenantPrefix}#CORPUSDATE`, GSI1SK: `${record.date}#${record.articleId}` });
  }

  async listCorpusByDate(from: string, to: string, limit = 500): Promise<CorpusIndexRecord[]> {
    return this.db.query<CorpusIndexRecord>({ index: 'GSI1', pk: `${keys.tenantPrefix}#CORPUSDATE`, skBetween: [`${from}#`, `${to}#\uffff`], scanForward: false, limit });
  }

  async incrementCorpusDay(day: string, delta: number): Promise<void> {
    await this.db.update(keys.corpusDay(day), { set: { type: 'CorpusDay', day }, add: { count: delta } });
  }

  async listCorpusDays(limit = 60): Promise<CorpusDayRecord[]> {
    return this.db.query<CorpusDayRecord>({ pk: keys.corpusDay('').PK, skPrefix: 'D#', scanForward: false, limit });
  }

  async putSyncRun(record: Omit<SyncRunRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.syncRun(record.startedAt), type: 'SyncRun', ...record });
  }

  async listSyncRuns(limit = 30): Promise<SyncRunRecord[]> {
    return this.db.query<SyncRunRecord>({ pk: keys.syncRun('').PK, scanForward: false, limit });
  }

  /* ------------------------------ Evaluaciones ------------------------------ */

  async putEvalCase(record: Omit<EvalCaseRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.evalCase(record.id), type: 'EvalCase', ...record });
  }

  async listEvalCases(): Promise<EvalCaseRecord[]> {
    return this.db.query<EvalCaseRecord>({ pk: keys.evalCase('').PK, skPrefix: 'CASE#', all: true });
  }

  async deleteEvalCase(id: string): Promise<void> {
    await this.db.delete(keys.evalCase(id));
  }

  async putEvalRun(record: Omit<EvalRunRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.evalRun(record.startedAt), type: 'EvalRun', ...record });
  }

  async listEvalRuns(limit = 20): Promise<EvalRunRecord[]> {
    return this.db.query<EvalRunRecord>({ pk: keys.evalRun('').PK, skPrefix: 'RUN#', scanForward: false, limit });
  }

  /* --------------------------------- Sesgo --------------------------------- */

  async putBiasReport(record: Omit<BiasReportRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.bias(record.day), type: 'BiasReport', ...record });
  }

  async listBiasReports(limit = 30): Promise<BiasReportRecord[]> {
    return this.db.query<BiasReportRecord>({ pk: keys.bias('').PK, skPrefix: 'DAY#', scanForward: false, limit });
  }

  /* -------------------------------- Canales -------------------------------- */

  async getChannels(): Promise<ChannelsRecord | undefined> {
    return this.db.get<ChannelsRecord>(keys.channels());
  }

  async putChannels(record: Omit<ChannelsRecord, 'PK' | 'SK' | 'type'>): Promise<void> {
    await this.db.put({ ...keys.channels(), type: 'Channels', ...record });
  }

  /* ------------------------------- Auditoría ------------------------------- */

  async putAudit(record: Omit<AuditRecord, 'PK' | 'SK' | 'type' | 'id' | 'at'> & { at?: string }): Promise<AuditRecord> {
    const at = record.at ?? new Date().toISOString();
    const id = ulid(Date.parse(at));
    const full: AuditRecord = { ...keys.audit(at, id), type: 'Audit', id, at, ...record };
    await this.db.put(full);
    return full;
  }

  async listAudit(from: string, to: string, limit = 200): Promise<AuditRecord[]> {
    return this.db.query<AuditRecord>({ pk: keys.audit('', '').PK, skBetween: [from, `${to}\uffff`], scanForward: false, limit });
  }

  /* ------------------------------- Borrado ------------------------------- */

  /** Borrado físico del lector (8.4): perfil, versiones, conversaciones, mensajes, clics, identidades. */
  async deleteReaderData(readerId: string, identities: { channel: string; hash: string }[]): Promise<{ deletedItems: number; strippedLogs: number }> {
    let deletedItems = 0;
    let strippedLogs = 0;
    const conversations = await this.listConversations(readerId);
    for (const conversation of conversations) {
      const messages = await this.listMessages(conversation.convId);
      for (const message of messages) {
        await this.updateQuestionLog(message.msgId, {}, ['readerId', 'cohort']);
        strippedLogs += 1;
      }
      await this.db.batchDelete(messages.map((message) => ({ PK: message.PK, SK: message.SK })));
      deletedItems += messages.length;
    }
    const rows = await this.db.query<Key>({ pk: keys.readerPk(readerId), all: true });
    await this.db.batchDelete(rows.map((row) => ({ PK: row.PK, SK: row.SK })));
    deletedItems += rows.length;
    for (const identity of identities) {
      await this.db.delete(keys.identity(identity.channel, identity.hash));
      deletedItems += 1;
    }
    return { deletedItems, strippedLogs };
  }

  /** Utilidad para listar ítems de un lector por tipo de SK. */
  async listReaderItems<T extends object>(readerId: string, skPrefix: string): Promise<T[]> {
    return this.db.query<T>({ pk: keys.readerPk(readerId), skPrefix, all: true });
  }
}

export { splitSk };
