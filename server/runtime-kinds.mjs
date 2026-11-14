// The kinds of local LLM runtime the push agent and the hub's adapters read (agent.json → runtimes[].kind). A leaf
// module: it imports nothing, so the push agent (scripts/agent/) reads runtimes through server/runtime-adapters.mjs
// without the site configuration. server/site-config.mjs keeps its own copy for site.json → runtimes[].kind (so a
// plugin's host agent copies no extra file); tests/agent-process.test.mjs holds the two equal.
export const RUNTIME_KINDS=Object.freeze(['auto','llama-swap','ollama','lmstudio','llama-cpp','vllm','sglang','omlx','mlx-serve','openai']);
