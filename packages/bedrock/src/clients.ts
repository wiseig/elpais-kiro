import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

let runtime: BedrockRuntimeClient | undefined;
let agentRuntime: BedrockAgentRuntimeClient | undefined;

const region = () => process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

export function bedrockRuntime(): BedrockRuntimeClient {
  runtime ??= new BedrockRuntimeClient({ region: region(), maxAttempts: 3 });
  return runtime;
}

export function bedrockAgentRuntime(): BedrockAgentRuntimeClient {
  agentRuntime ??= new BedrockAgentRuntimeClient({ region: region(), maxAttempts: 3 });
  return agentRuntime;
}

/** Para tests: inyectar clientes falsos. */
export function setBedrockClients(clients: { runtime?: BedrockRuntimeClient; agentRuntime?: BedrockAgentRuntimeClient }): void {
  if (clients.runtime) runtime = clients.runtime;
  if (clients.agentRuntime) agentRuntime = clients.agentRuntime;
}
