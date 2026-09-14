export interface InferenceBatch {
  version: 1;
  model_id: string;
  request_count: number;
  started_at: number;
  finished_at: number;
  receipt_root: string;
}

export function validateInferenceBatch(input: InferenceBatch): InferenceBatch {
  const fields = ['version', 'model_id', 'request_count', 'started_at', 'finished_at', 'receipt_root'];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))
    || input.version !== 1 || typeof input.model_id !== 'string' || !input.model_id.trim() || input.model_id.length > 512
    || !Number.isSafeInteger(input.request_count) || input.request_count < 1
    || !Number.isSafeInteger(input.started_at) || input.started_at <= 0
    || !Number.isSafeInteger(input.finished_at) || input.finished_at <= input.started_at || input.finished_at > 8640000000000000
    || typeof input.receipt_root !== 'string' || !/^[a-f0-9]{64}$/.test(input.receipt_root)) {
    throw new Error('Invalid inference batch: use only model, count, interval and receipt root fields');
  }
  return { version: 1, model_id: input.model_id, request_count: input.request_count,
    started_at: input.started_at, finished_at: input.finished_at, receipt_root: input.receipt_root };
}
