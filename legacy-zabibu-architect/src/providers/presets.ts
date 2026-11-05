// The provider registry. Every entry speaks the OpenAI chat-completions dialect,
// which is why there is only one real client underneath.
//
// `free: true` means an account gets you a usable free tier — or, for pollinations,
// no account at all. `nativeTools` says whether the endpoint honours the `tools`
// parameter; when it does not, the agent falls back to a prompted tool protocol.
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Appended to baseUrl. Empty when baseUrl *is* the completions endpoint. */
  completionsPath: string;
  /** Environment variable holding the key. null means no key is needed. */
  keyEnv: string | null;
  defaultModel: string;
  free: boolean;
  /** Where to get a key, or where to install the runtime. */
  signup: string | null;
  note: string;
  nativeTools: boolean;
  /** Overridden when the model listing does not live at `${baseUrl}/models`. */
  modelsUrl?: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "pollinations",
    label: "Pollinations",
    baseUrl: "https://text.pollinations.ai/openai",
    completionsPath: "",
    modelsUrl: "https://text.pollinations.ai/models",
    keyEnv: null,
    defaultModel: "openai",
    free: true,
    signup: null,
    note: "No account and no key — Weaver's out-of-the-box default. Community-run and best-effort, so expect it to be slower than the rest.",
    nativeTools: true,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    completionsPath: "/chat/completions",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "openai/gpt-oss-120b",
    free: true,
    signup: "https://console.groq.com/keys",
    note: "Free tier, and by far the fastest of these. The best choice if you want speed.",
    nativeTools: true,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    completionsPath: "/chat/completions",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3.8-flash",
    free: true,
    signup: "https://aistudio.google.com/apikey",
    note: "Generous free tier through Google AI Studio.",
    nativeTools: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    completionsPath: "/chat/completions",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    free: true,
    signup: "https://openrouter.ai/keys",
    note: "One key, hundreds of models. Ids ending in :free cost nothing.",
    nativeTools: true,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    completionsPath: "/chat/completions",
    keyEnv: null,
    defaultModel: "qwen2.5-coder:7b",
    free: true,
    signup: "https://ollama.com/download",
    note: "Runs on your machine, so nothing leaves it. Requires Ollama installed and the model pulled.",
    nativeTools: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    completionsPath: "/chat/completions",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    free: false,
    signup: "https://platform.openai.com/api-keys",
    note: "Paid.",
    nativeTools: true,
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    completionsPath: "/chat/completions",
    keyEnv: "TOGETHER_API_KEY",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    free: false,
    signup: "https://api.together.xyz/settings/api-keys",
    note: "Paid after any trial credit.",
    nativeTools: true,
  },
];

/** The offline demo. Not a network provider, but it is listed like one. */
export const MOCK_ID = "mock";

export function presetById(id: string): ProviderPreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/** The full chat-completions URL for a preset. */
export function endpointFor(preset: ProviderPreset): string {
  return `${preset.baseUrl.replace(/\/+$/, "")}${preset.completionsPath}`;
}

/** Where to list a preset's models. */
export function modelsUrlFor(preset: ProviderPreset): string {
  if (preset.modelsUrl !== undefined) return preset.modelsUrl;
  return `${preset.baseUrl.replace(/\/+$/, "")}/models`;
}

/** The key for a provider, or null when it needs none or none is set. */
export function keyFor(preset: ProviderPreset): string | null {
  if (preset.keyEnv === null) return null;
  const value = process.env[preset.keyEnv];
  return value !== undefined && value.length > 0 ? value : null;
}

/** The `weaver providers` ordering: free and keyless first, paid last. */
export function presetsInDisplayOrder(): ProviderPreset[] {
  return [...PRESETS].sort((a, b) => {
    const tier = (preset: ProviderPreset): number => (preset.keyEnv === null ? 0 : preset.free ? 1 : 2);
    return tier(a) - tier(b);
  });
}
