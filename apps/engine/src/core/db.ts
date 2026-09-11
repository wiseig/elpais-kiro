import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Key } from '@pelp/domain';

export interface QueryParams {
  pk: string;
  skPrefix?: string;
  skBetween?: [string, string];
  index?: 'GSI1' | 'GSI2';
  limit?: number;
  scanForward?: boolean;
  /** Paginar hasta agotar (con tope de seguridad de 20 páginas). */
  all?: boolean;
}

export interface UpdateExpr {
  set?: Record<string, unknown>;
  add?: Record<string, number>;
  remove?: string[];
  mustExist?: boolean;
}

/** Abstracción mínima de la tabla única. Permite un fake en memoria para tests. */
export interface Db {
  get<T extends object>(key: Key): Promise<T | undefined>;
  put<T extends Key>(item: T, options?: { ifNotExists?: boolean }): Promise<boolean>;
  update(key: Key, expr: UpdateExpr): Promise<Record<string, unknown> | undefined>;
  delete(key: Key): Promise<void>;
  query<T extends object>(params: QueryParams): Promise<T[]>;
  batchDelete(keys: Key[]): Promise<void>;
}

const INDEX_KEYS = {
  GSI1: { pk: 'GSI1PK', sk: 'GSI1SK' },
  GSI2: { pk: 'GSI2PK', sk: 'GSI2SK' },
} as const;

function isConditionalFailure(error: unknown): boolean {
  return (error as { name?: string }).name === 'ConditionalCheckFailedException';
}

export class DynamoDb implements Db {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1', maxAttempts: 3 }), {
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
      });
  }

  async get<T extends object>(key: Key): Promise<T | undefined> {
    const output = await this.client.send(new GetCommand({ TableName: this.tableName, Key: key }));
    return output.Item as T | undefined;
  }

  async put<T extends Key>(item: T, options?: { ifNotExists?: boolean }): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item as unknown as Record<string, unknown>,
          ...(options?.ifNotExists ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
        }),
      );
      return true;
    } catch (error) {
      if (options?.ifNotExists && isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async update(key: Key, expr: UpdateExpr): Promise<Record<string, unknown> | undefined> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const parts: string[] = [];
    let counter = 0;
    // Soporta rutas anidadas ("byChannel.web") mapeando cada segmento a un alias.
    const name = (attribute: string): string =>
      attribute
        .split('.')
        .map((segment) => {
          const token = `#n${counter}`;
          names[token] = segment;
          counter += 1;
          return token;
        })
        .join('.');
    if (expr.set && Object.keys(expr.set).length) {
      const sets = Object.entries(expr.set).map(([attribute, value], index) => {
        const token = `:s${index}`;
        values[token] = value;
        return `${name(attribute)} = ${token}`;
      });
      parts.push(`SET ${sets.join(', ')}`);
    }
    if (expr.add && Object.keys(expr.add).length) {
      const adds = Object.entries(expr.add).map(([attribute, value], index) => {
        const token = `:a${index}`;
        values[token] = value;
        return `${name(attribute)} ${token}`;
      });
      parts.push(`ADD ${adds.join(', ')}`);
    }
    if (expr.remove?.length) parts.push(`REMOVE ${expr.remove.map((attribute) => name(attribute)).join(', ')}`);
    if (!parts.length) return undefined;
    const output = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression: parts.join(' '),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ...(expr.mustExist ? { ConditionExpression: 'attribute_exists(PK)' } : {}),
        ReturnValues: 'ALL_NEW',
      }),
    );
    return output.Attributes as Record<string, unknown> | undefined;
  }

  async delete(key: Key): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: key }));
  }

  async query<T extends object>(params: QueryParams): Promise<T[]> {
    const keyNames = params.index ? INDEX_KEYS[params.index] : { pk: 'PK', sk: 'SK' };
    const names: Record<string, string> = { '#pk': keyNames.pk };
    const values: Record<string, unknown> = { ':pk': params.pk };
    let condition = '#pk = :pk';
    if (params.skPrefix !== undefined) {
      names['#sk'] = keyNames.sk;
      condition += ' AND begins_with(#sk, :prefix)';
      values[':prefix'] = params.skPrefix;
    } else if (params.skBetween) {
      names['#sk'] = keyNames.sk;
      condition += ' AND #sk BETWEEN :from AND :to';
      values[':from'] = params.skBetween[0];
      values[':to'] = params.skBetween[1];
    }
    const items: T[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let pages = 0;
    do {
      const output = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          ...(params.index ? { IndexName: params.index } : {}),
          KeyConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ScanIndexForward: params.scanForward ?? true,
          ...(params.limit ? { Limit: params.limit } : {}),
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      items.push(...((output.Items ?? []) as T[]));
      exclusiveStartKey = output.LastEvaluatedKey as Record<string, unknown> | undefined;
      pages += 1;
      if (params.limit && items.length >= params.limit) break;
    } while (params.all && exclusiveStartKey && pages < 20);
    return params.limit ? items.slice(0, params.limit) : items;
  }

  async batchDelete(keys: Key[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 25) {
      const chunk = keys.slice(i, i + 25);
      await this.client.send(
        new BatchWriteCommand({
          RequestItems: { [this.tableName]: chunk.map((key) => ({ DeleteRequest: { Key: key } })) },
        }),
      );
    }
  }
}

/** Fake en memoria con la misma semántica de claves. Para tests y scripts locales. */
export class MemoryDb implements Db {
  readonly items = new Map<string, Record<string, unknown> & Key>();

  private static id(key: Key): string {
    return `${key.PK} ${key.SK}`;
  }

  async get<T extends object>(key: Key): Promise<T | undefined> {
    const item = this.items.get(MemoryDb.id(key));
    return item ? (structuredClone(item) as unknown as T) : undefined;
  }

  async put<T extends Key>(item: T, options?: { ifNotExists?: boolean }): Promise<boolean> {
    const id = MemoryDb.id(item);
    if (options?.ifNotExists && this.items.has(id)) return false;
    this.items.set(id, structuredClone(item) as unknown as Record<string, unknown> & Key);
    return true;
  }

  async update(key: Key, expr: UpdateExpr): Promise<Record<string, unknown> | undefined> {
    const id = MemoryDb.id(key);
    const existing = this.items.get(id);
    if (!existing && expr.mustExist) {
      const error = new Error('The conditional request failed');
      error.name = 'ConditionalCheckFailedException';
      throw error;
    }
    const next: Record<string, unknown> & Key = existing ? structuredClone(existing) : { ...key };
    const setPath = (target: Record<string, unknown>, path: string, mutate: (current: unknown) => unknown): void => {
      const segments = path.split('.');
      let cursor = target;
      for (const segment of segments.slice(0, -1)) {
        const child = cursor[segment];
        if (!child || typeof child !== 'object') {
          const created: Record<string, unknown> = {};
          cursor[segment] = created;
          cursor = created;
        } else {
          cursor = child as Record<string, unknown>;
        }
      }
      const last = segments[segments.length - 1] ?? path;
      cursor[last] = mutate(cursor[last]);
    };
    for (const [attribute, value] of Object.entries(expr.set ?? {})) setPath(next, attribute, () => structuredClone(value));
    for (const [attribute, value] of Object.entries(expr.add ?? {})) {
      setPath(next, attribute, (current) => (typeof current === 'number' ? current : 0) + value);
    }
    for (const attribute of expr.remove ?? []) delete next[attribute];
    this.items.set(id, next);
    return structuredClone(next);
  }

  async delete(key: Key): Promise<void> {
    this.items.delete(MemoryDb.id(key));
  }

  async query<T extends object>(params: QueryParams): Promise<T[]> {
    const keyNames = params.index ? INDEX_KEYS[params.index] : { pk: 'PK', sk: 'SK' };
    let rows = [...this.items.values()].filter((item) => item[keyNames.pk] === params.pk);
    rows = rows.filter((item) => {
      const sk = String(item[keyNames.sk] ?? '');
      if (params.skPrefix !== undefined) return sk.startsWith(params.skPrefix);
      if (params.skBetween) return sk >= params.skBetween[0] && sk <= params.skBetween[1];
      return true;
    });
    rows.sort((a, b) => (String(a[keyNames.sk]) < String(b[keyNames.sk]) ? -1 : String(a[keyNames.sk]) > String(b[keyNames.sk]) ? 1 : 0));
    if (params.scanForward === false) rows.reverse();
    if (params.limit) rows = rows.slice(0, params.limit);
    return rows.map((row) => structuredClone(row) as unknown as T);
  }

  async batchDelete(keys: Key[]): Promise<void> {
    for (const key of keys) this.items.delete(MemoryDb.id(key));
  }
}
