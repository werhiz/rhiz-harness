# Third-party notices

Rhiz Harness is licensed under the Apache License, Version 2.0. This file lists
the third-party work it derives from, adapts, or depends on, with the license
each is distributed under. The per-module record of what was taken and how it
was changed lives in `provenance/`; this file is the summary a redistributor
needs.

## Derived or adapted source

| Upstream | License | Used in | Relationship |
| --- | --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex), via [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter) @ `5b07159c` | Apache-2.0 | `src/guard.ts`, `src/context.ts` | Guardian circuit-breaker state machine and tuning constants re-implemented in TypeScript; `ContextualUserFragment` marker discipline adapted. The upstream NOTICE is reproduced in `NOTICE`. |
| [Aider](https://github.com/Aider-AI/aider) | Apache-2.0 | `src/context.ts` | Repository-map selection re-implemented in spirit, not in code. |
| [LangChain](https://github.com/langchain-ai/langchain) | MIT | `src/context.ts` | `ClearToolUsesEdit` eviction adapted into a typed, deterministic edit. |

LangChain is distributed under the MIT License:

```
MIT License

Copyright (c) LangChain, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies and optional hosts

| Package | License | Relationship |
| --- | --- | --- |
| [zod](https://github.com/colinhacks/zod) | MIT | Runtime dependency. Not redistributed in this repository. |
| `@deepseek-ai/*` DeepSeek Harness (DSH) packages | Repository: MIT. The npm packages `dsh-sdk-client`, `dsh-subagent`, `dsh-subagent-claude-code`, `dsh-subagent-codex`, `dsh-subprocess`, `dsh-subprocess-local` declare BSD-3-Clause; `@deepseek-ai/cordis` declares MIT. | Optional peer dependencies behind `adapters/dsh/`. Rhiz Harness calls their public API and redistributes none of their code. |

Studied without copying code, so carrying no obligation: the OpenTelemetry
Collector (Apache-2.0) and LangChain routing (MIT) for the Router.
