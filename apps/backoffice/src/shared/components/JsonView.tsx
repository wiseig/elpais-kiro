import { prettyJson } from '../format';

export function JsonView({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="json" style={{ maxHeight }}>
      {prettyJson(value)}
    </pre>
  );
}
