# Repository Guidelines

## Project Structure & Module Organization

LibreTV is a Next.js 15 App Router application using React 19, TypeScript, and Tailwind CSS.

- `src/app/`: pages, layouts, global styles, and API handlers (`api/**/route.ts`).
- `src/components/`: reusable UI, players, settings panels, and React hooks.
- `src/lib/`: parsers, authentication, proxy security, playback utilities, Zustand state, and persistence.
- Tests live beside implementation files as `*.test.ts`, including API route tests.
- `public/`: static web assets; `build/`: Electron packaging resources.
- `electron/` and `scripts/`: desktop integration, packaging, release, and smoke-check tooling.
- `docs/`: design notes and deployment instructions.

## Build, Test, and Development Commands

Install dependencies with `npm ci` using the committed lockfile.

- `npm run dev`: start local development at `http://localhost:8080`.
- `npm run build`: create the production Next.js build.
- `npm start`: serve the production build on port 8080.
- `npm run lint`: run ESLint over `src/`.
- `npm run typecheck`: check TypeScript without emitting files.
- `npm test`: run the Vitest suite once.
- `npm test -- src/lib/quality.test.ts`: run one test file.
- `npm run desktop:build`: package the Windows x64 NSIS installer into `release/`; use Windows with Node.js 22+.

## Coding Style & Naming Conventions

Follow existing two-space indentation, single quotes, and semicolons. TypeScript uses strict mode; prefer explicit domain types and `import type` where appropriate. Use `@/` for imports rooted in `src/`.

Use kebab-case filenames (`video-card.tsx`), PascalCase React components, camelCase functions, and `use`-prefixed hooks. Mark browser-dependent components with `'use client'`. Styling uses Tailwind and `src/app/globals.css`. ESLint extends Next.js Core Web Vitals and TypeScript rules; no dedicated formatter is configured.

## Testing Guidelines

Vitest runs `src/**/*.test.ts` in a Node environment. Use descriptive `describe`/`it` cases, mock external requests, and cover relevant failure paths when changing parsers, authentication, proxies, or playback logic. No coverage threshold is configured. Run tests, lint, and type checking before submitting; manually verify affected UI flows.

## Commit & Pull Request Guidelines

Recent commits use prefixes such as `feat:`, `fix:`, `chore:`, and `docs:`, often with Chinese descriptions. Keep commits focused. PRs should explain the problem, resulting behavior, validation performed, and related issues. Include screenshots for visible UI changes.

## Security & Configuration Tips

Use `.env.example` as a reference and keep local secrets in `.env.local`. Configure `PASSWORD` for local use; never commit credentials. Preserve SSRF checks and proxy authentication. Enable `LIVE_ALLOW_PRIVATE=1` only for intentional private-network IPTV access.
