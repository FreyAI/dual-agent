# Security Policy

## Supported versions

Only the latest minor release (the newest version on GitHub) receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories: open the repository's **Security** tab and click **Report a vulnerability**. Do not open a public issue, and do not include secrets or personal data of others in a report.

We aim to acknowledge a report within a few days and will coordinate a fix and disclosure with you.

## Scope notes

- **API keys.** The DeepSeek and Anthropic API keys set with "Set DeepSeek API Key" / "Set Anthropic API Key" are stored in VS Code's SecretStorage (`src/providers.ts:165-166`, keys `dualAgent.deepseekApiKey` and `dualAgent.anthropicApiKey`). They are not written to settings or the workspace. A key file, if configured with `dualAgent.deepseek.apiKeyFile`, is read from disk and takes precedence over SecretStorage (`src/providers.ts:190-194`); the same NAME=value file can hold other tool tokens.
- **Where keys go.** Keys are sent only to the provider they belong to: DeepSeek's endpoint (`dualAgent.deepseek.baseUrl`) or Anthropic. Your Claude sign-in is never sent to DeepSeek.
- **Agent permissions.** The agent can run commands and edit files in your workspace. `dualAgent.permissionMode` controls whether it asks first; `bypassPermissions` removes all prompts.

This document describes the code in this repository, not any third-party extension.
