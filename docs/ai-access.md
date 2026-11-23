# AI access preview

This branch of Agent lets an AI coding assistant, such as Claude Code or Codex, read your UHK configuration and propose changes to keys, keymaps, macros, and settings. Nothing reaches the keyboard until you review the proposed changes in Agent and click **Save to keyboard**. The assistant talks to Agent through an MCP server (Model Context Protocol, the standard way AI assistants connect to tools) that runs inside Agent on your own computer.

This is a preview build from a fork, not an official Agent release. It has been tested end to end on a UHK 80 with firmware v18.0.3 on macOS. Other models, including the UHK 60 v2, should work because the feature uses the same Agent code for every model, but they have not been tested.

## What you need

- A UHK running firmware v18.0.x. If Agent shows an **Update firmware** page when you connect, use it: it flashes v18.0.3, which this build is made for.
- Node.js 24.18.1 or newer, below 25, with npm 11.13 or newer. The main README still says Node.js 20; the build refuses older versions.
  Install [nvm](https://github.com/nvm-sh/nvm) and run `nvm install 24`.
- `libusb`. On macOS, run `xcode-select --install` first if the Xcode Command Line Tools are missing. Then run `brew install libusb libusb-compat`. On Debian-based Linux: `apt-get install libusb-dev libudev-dev g++`.
- Claude Code or Codex.

## Build and run

```
git clone https://github.com/nwant/agent.git
cd agent
git checkout ai-access-preview
npm run install
npm run build
npm run electron
```

Quit any other copy of Agent first: only one copy can talk to the keyboard. On Linux, Agent asks to install udev rules on first run so it can reach the keyboard over USB; accept.

## Connect your assistant

1. In Agent, open **Settings** (bottom of the sidebar) and scroll to **AI access**.
2. Tick **Allow AI clients to read keyboard information and propose key and macro changes**.
3. Choose **Claude Code** or **Codex** and click the copy button in the corner of the box. The copy contains your access token even while the eye button keeps it hidden on screen.
4. Connect:
   - **Claude Code:** paste the command into a terminal and run it. Keep it out of the assistant’s chat because it contains your access token. Then start a new Claude Code session so it picks up the new server.
   - **Codex:** paste the entry into `~/.codex/config.toml` and restart Codex.
5. Ask the assistant to call `get_device_info`. It should report your keyboard model and firmware version.

The server listens only on this computer (127.0.0.1), on port 53417 unless you change it. It keeps working while Agent is minimized to the system tray, and stops when Agent quits.

## How a change works

1. The assistant reads your keymaps with `list_keymaps` and `get_layer`, your macros with `list_macros` and `get_macro`, and your settings with `get_settings`. It can also read the smart-macro manual for your firmware with `get_reference_manual`.
2. It proposes changes in Agent:
   - Change a key with `set_key_action`.
   - Manage keymaps with `duplicate_keymap`, `rename_keymap`, `delete_keymap`, or `set_default_keymap`.
   - Manage macros with `create_macro`, `update_macro`, `rename_macro`, or `delete_macro`.
   - Change settings with `update_settings`. Settings changes also go through **Review changes** and **Save to keyboard**.
3. In Agent, click **Review changes**. Changes the assistant made are tagged as AI changes, macro text is shown in full, and Agent flags risky ones: macros that run without a key press (such as `$onInit`), type into your computer, open a launcher or shell, or that Agent cannot check.
4. Click **Save to keyboard**. Changes that run without a key press or open a launcher or shell need a second confirmation.
5. Press the key. If a macro fails, the assistant can read the firmware's error and `setStatus` output with `get_macro_errors` and propose a fix.

**Review changes** also has a **Discard all** control that reloads the configuration from the keyboard.

## Privacy and the access token

- Text macro contents are hidden from the assistant unless you tick **Let AI read text macro contents**. Leave it off if a text macro holds a password.
- The token is stored in plain text in the assistant's configuration: `~/.claude.json` for Claude Code, `~/.codex/config.toml` for Codex. Anyone who can read those files can read your configuration and propose changes while Agent runs, though only you can save them to the keyboard.
- **Regenerate token** disconnects every connected assistant. Afterwards, copy the new command or entry and connect again.

## Differences from official Agent

This branch writes configuration format 15.0.0, which released firmware reads, so it leaves out two newer settings from Agent's development branch: touchpad drag style and module angle. Everything else matches Agent's development branch plus the AI access feature.

## For coding assistants setting this up

- Check `node --version` before building; `npm run build` fails on versions outside the range above.
- `npm run electron` starts a desktop app and does not return. Run it in the background or a separate terminal.
- Enabling AI access, reviewing, saving to the keyboard and pressing keys are for the person at the keyboard. Ask them to do these steps; do not try to click them yourself.
- After the person runs the connect command, the new MCP server's tools appear only in a new assistant session.

## Reporting problems

This fork has no issue tracker. Send problems to whoever shared this branch with you, with your keyboard model, firmware version, operating system, and what the assistant and Agent showed. On a model other than the UHK 80, results from `get_device_info` and `get_layer` are especially useful.
