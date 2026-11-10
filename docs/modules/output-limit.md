# outputLimit

Keeps huge results out of the agent's context.

```ts
outputLimit({
  maxTokens: 8_000,
  strategy: "truncate-with-notice",   // or "error" | "summarize"
  summarize: async (text, ctx) => llm.summarize(text),
  perTool: { search_logs: 2_000 },
  estimate: (text) => Math.ceil(text.length / 4),   // default
})
```

- Counts text blocks, embedded resource text and `structuredContent`. Images and audio are kept and not counted.
- **truncate-with-notice** cuts text blocks to fit and appends a notice telling the model output was cut and how to ask for less. `_meta.gantry` carries `OUTPUT_TRUNCATED` with the original and kept sizes.
- **summarize** replaces the text with your summary, and falls back to truncation if the callback fails or the summary is still too long.
- **error** returns `OUTPUT_TOO_LARGE`. So does truncation when `structuredContent` alone is over budget, since cutting it would break the tool's output schema.

The default estimator is characters / 4. Pass your tokenizer for exact counts.

## When you don't need this

Your tools already paginate and cap their responses.
