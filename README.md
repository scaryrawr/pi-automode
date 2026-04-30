# pi-automode

An extension for [pi](https://github.com/mariozechner/pi-coding-agent) that adds intelligent bash command classification — a safety layer that evaluates every shell command before it runs.

## What it does

When pi (the AI coding agent) generates a shell command, automode intercepts it and uses an AI model to classify the command into one of three categories:

| Classification | Behavior                                               |
| -------------- | ------------------------------------------------------ |
| **Safe**       | Command runs without interruption                      |
| **Ask**        | pi pauses and asks you for confirmation before running |
| **Dangerous**  | Command is blocked outright                            |

It also includes a built-in list of known-safe commands (e.g., `ls`, `cat`, `echo`) that are allowed instantly without consuming any model tokens.

## How it works

1. A user message triggers pi to generate a bash tool call.
2. Automode intercepts the call and extracts the command text (along with the latest user prompt for context).
3. It spins up a lightweight, in-memory agent session using a classifier model you choose.
4. The classifier model evaluates the command and calls a custom `classify_shell_command` tool to return its verdict.
5. Based on the verdict, the command is either allowed, blocked, or the agent is instructed to ask the user.
6. The session is immediately torn down — no state is persisted between classifications.

## Installation

Install the extension using pi's built-in install command:

```bash
pi install git:github.com/scaryrawr/pi-automode
```

## Configuration

Automode needs a model to do its classification. By default, it falls back to your pi's **default model**.

To use a dedicated model for classification (e.g., a lightweight local model), set one via the `/automodel` command:

```
/automodel
```

This opens an interactive model selector. Your choice is persisted to `automode.json` in pi's shared agent directory (`~/.pi/`) and is used for all future classification calls until changed.

## License

MIT
