/** Eventos del motor (secciones 6.1, 8.3, 9.3). Se publican en EventBridge y/o se persisten. */
export type EngineEventType =
  | 'QuestionAnswered'
  | 'Blocked'
  | 'PersonalizationRejected'
  | 'ProfileDue'
  | 'SourceClicked'
  | 'ConsentRecorded'
  | 'FeedbackGiven'
  | 'AnswerReady';

export interface EngineEventBase<T extends EngineEventType, D> {
  type: T;
  at: string;
  channel: string;
  detail: D;
}

export type ProfileDueEvent = EngineEventBase<'ProfileDue', { readerId: string; questionCount: number }>;

export type AnswerReadyEvent = EngineEventBase<
  'AnswerReady',
  { answer: unknown; conversationId: string; channelUserId: string; meta?: Record<string, string> }
>;

export const EVENT_SOURCE = 'pelp.engine';
