// Loaded only by dsh-cli.test.mjs in its disposable DSH_HOME.
//
// Besides the workspace and preset the bridge contract needs, this registers a
// real LLM adapter with no network behind it. That lets the isolated official
// host exercise the model-control path end to end — MCP wire, bridge, DSH's own
// `model/selection` seam, durable session log and read-back — without a
// credential, a paid request or a real model call.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['workspaceRegistry', 'agentPresets', 'llm'];

const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
];

/** One provider, two models, one of which declares thinking levels. */
class ContractAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'Bridge Contract Provider' };
  }
  async listModels(provider) {
    return [
      { provider, id: 'contract-flash', name: 'Contract Flash' },
      { provider, id: 'contract-think', name: 'Contract Think' },
    ];
  }
  async resolveModel(provider, model) {
    if (model === 'contract-think') {
      return {
        provider, id: model, name: 'Contract Think',
        reasoning: { efforts: EFFORTS, defaultEffort: 'low' },
        context: { contextWindow: 64000 },
      };
    }
    return { provider, id: model, name: 'Contract Flash' };
  }
  async *stream() {
    throw new Error('the contract fixture never calls a model');
  }
}

export async function apply(ctx) {
  await ctx.workspaceRegistry.create(process.cwd(), 'Bridge contract workspace');
  const unregister = await ctx.agentPresets.register({ id: 'bridge-contract', plugins: [] });
  ctx.effect(() => unregister);
  const releaseAdapter = ctx.llm.registerAdapter(['bridge-contract'], new ContractAdapter());
  ctx.effect(() => releaseAdapter);
}
