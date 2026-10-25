# Models

The one place model ids and prices live: `src/models.ts` reads this file for
the DeepSeek defaults and `src/usage.ts` for every cost.

Each model is its id followed by `:`, then one tab-indented `key: value` line
per attribute. Prices are USD per 1,000,000 tokens. The first model whose
`match` fits an id prices it, so keep specific models above their family.

- `match`: regex for the ids it prices (case-insensitive); default is the id itself
- `default`: the DeepSeek tier it is the default for (`flash` or `thinking`)
- `input`, `cache read`, `output`: price
- `cache write`: multiple of the input price (Claude 1.25; DeepSeek writes are free)
- `off-peak half`: `yes` when the price halves outside peak hours
- any other key (like `note`) is just for reading

Checked 2026-10-25 against <https://platform.claude.com/docs/en/about-claude/pricing>
and <https://api-docs.deepseek.com/quick_start/pricing> (peak rates). DeepSeek
peak is 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri. A newer stable DeepSeek
model is found daily from its `/models` endpoint and priced by these rows.

Not modelled: Haiku 5.5 charges 5x for prompts over 100,000 tokens; DeepSeek
is off-peak all day on Chinese public holidays.

## DeepSeek

deepseek-flash:
	match: deepseek.*flash
	default: flash
	input: 0.3
	cache read: 0.006
	cache write: 0
	output: 1.2
	off-peak half: yes

deepseek-v4-pro:
	match: deepseek
	default: thinking
	note: every other DeepSeek id (reasoner, chat, v5-pro, ...)
	input: 1.32
	cache read: 0.044
	cache write: 0
	output: 3.96
	off-peak half: yes

## Claude

claude-fable-5-1:
	match: fable-5-1|mythos-5-1
	input: 10
	cache read: 0.25
	cache write: 1.25
	output: 50

claude-fable-5:
	match: fable|mythos
	note: Fable 5 and Mythos 5 read the cache at the usual 0.1x
	input: 10
	cache read: 1
	cache write: 1.25
	output: 50

claude-opus-5-5:
	match: opus-5-5
	input: 4
	cache read: 0.2
	cache write: 1.25
	output: 20

claude-opus:
	match: opus
	note: older Opus (4.6, 4.8)
	input: 5
	cache read: 0.5
	cache write: 1.25
	output: 25

claude-sonnet-5-5:
	match: sonnet-5-5
	input: 2
	cache read: 0.1
	cache write: 1.25
	output: 10

claude-sonnet-5:
	match: sonnet-5
	input: 2
	cache read: 0.2
	cache write: 1.25
	output: 10

claude-sonnet:
	match: sonnet
	note: older Sonnet (4.6)
	input: 3
	cache read: 0.3
	cache write: 1.25
	output: 15

claude-haiku-5-5:
	match: haiku-5
	input: 0.1
	cache read: 0.01
	cache write: 1.25
	output: 0.5

claude-haiku:
	match: haiku
	note: older Haiku (4.5)
	input: 1
	cache read: 0.1
	cache write: 1.25
	output: 5
