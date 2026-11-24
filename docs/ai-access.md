# AI access preview

This branch of Agent lets an AI coding assistant, such as Claude Code or Codex, read your UHK configuration and propose changes to keys, keymaps, macros, and settings. Nothing reaches the keyboard until you review the proposed changes in Agent and click **Save to keyboard**, unless you [let the assistant save](#let-the-assistant-save). The assistant talks to Agent through an MCP server (Model Context Protocol, the standard way AI assistants connect to tools) that runs inside Agent on your own computer.

This is a preview build from a fork, not an official Agent release. It has been tested end to end on a UHK 80 with firmware v18.0.3 on macOS. Letting the assistant save is newer: it was tested with Codex on a UHK 80 on macOS, running a custom firmware build that reports v18.0.3. Other models, including the UHK 60 v2, should work because the feature uses the same Agent code for every model, but they have not been tested.

## Set up with an assistant

Point your assistant at the `ai-access-preview` branch of `https://github.com/nwant/agent` and ask it to follow this section. Assistants: do the steps marked **Assistant**, ask the person to do the steps marked **Person**, and check each step before the next. Rules for assistants are [at the end](#for-coding-assistants).

1. **Person:** in the Agent you use now, open **Configuration** under **Device**, click **Export device configuration** and keep the file. Then quit Agent.
2. **Assistant:** check what is listed under [What you need](#what-you-need), then follow [Build and run](#build-and-run). Check: `npm run build` ends without errors.
3. **Assistant:** start Agent with `npm run electron` in the background. Check with the person that it shows their keyboard. If it shows something else, see [If something goes wrong](#if-something-goes-wrong).
4. **Person:** follow [Connect your assistant](#connect-your-assistant). Start a new assistant session afterwards.
5. **Assistant:** call `get_device_info` and `get_unsaved_changes`. Check: the keyboard is connected and nothing is unsaved. If something is unsaved, stop and ask.
6. **Try a change that the person saves.**
   - **Assistant:** ask for a key to test with, and read it with `get_layer`. Its action must be `none`. Propose a letter for it with `set_key_action`, for example `{"keyActionType": "keystroke", "type": "basic", "scancode": 4}` for the letter a on a US layout.
   - **Person:** check the proposal in **Review changes**, click **Save to keyboard**, then press the key in a text editor.
   - **Assistant:** put the key back to `none`. **Person:** save again.
7. **Optional: let the assistant save.**
   - **Person:** read [Let the assistant save](#let-the-assistant-save), then tick **Let AI clients save to the keyboard**. Do not click **Save to keyboard**.
   - **Assistant:** propose the same letter, call `save_to_keyboard` and report the reply. It should be `saved`.
   - **Person:** press the key in a text editor, and check that Agent shows a notice.
   - **Assistant:** put the key back to `none`, save, and check that nothing is unsaved.
8. **Assistant:** report what happened at each step, the keyboard model and the firmware version. See [Reporting problems](#reporting-problems).

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

If you already have a clone of this fork, run `git fetch origin`, `git checkout ai-access-preview` and `git pull` in it instead of the first three lines. Use a separate folder from any clone of the official Agent.

The first `npm run electron` downloads Electron. Agent runs until you quit it; to start it again, run only `npm run electron`.

Quit any other copy of Agent first: only one copy can talk to the keyboard. On Linux, Agent asks to install udev rules on first run so it can reach the keyboard over USB; accept.

## Connect your assistant

1. In Agent, open **Settings** (bottom of the sidebar) and scroll to **AI access**.
2. Tick **Allow AI clients to read your configuration and propose changes**. The AI access settings take effect at once: do not click **Save to keyboard** for them.
3. Choose **Claude Code** or **Codex** and click the copy button in the corner of the box. The copy contains your access token even while the eye button keeps it hidden on screen.
4. Connect:
   - **Claude Code:** paste the command into a terminal and run it in the folder where you will use Claude Code: the server is available only there. To use it everywhere, add `--scope user` after `claude mcp add`. Keep it out of the assistant’s chat because it contains your access token. Then start a new Claude Code session so it picks up the new server.
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
4. Click **Save to keyboard**, or have the assistant save if you allow it. When you click, changes that run without a key press or open a launcher or shell need a second confirmation.
5. Press the key. If a macro fails, the assistant can read the firmware's error and `setStatus` output with `get_macro_errors` and propose a fix.

**Review changes** also has a **Discard all** control that reloads the configuration from the keyboard.

## Let the assistant save

By default, only your click on **Save to keyboard** saves. To skip that click, tick **Let AI clients save to the keyboard** in **Settings**, under **AI access**. It takes effect at once. Do not click **Save to keyboard** to apply it: that saves every unsaved change, the assistant's included. The assistant can then save with `save_to_keyboard`.

- **You do not see the changes first.** The assistant can save without asking you in Agent. A mistaken or manipulated assistant can put a bad key or macro on your keyboard. Your assistant may still ask before it uses the tool, depending on its own permission settings. Do not count on that: in our tests, Codex had its own automated reviewer approve saves instead of asking a person.
- **A save includes everything unsaved,** your own changes too.
- **Some changes still need your click:** macros that run without a key press, macros that such a macro calls (every macro change, if Agent cannot tell which it calls), launcher or shell shortcuts Agent recognizes, and changes that could lock you out of the keyboard. Agent refuses to let the assistant save while any of these is waiting. Use **Review changes** and **Save to keyboard**.
- **Agent does not recognize every risk.** For example, the assistant can save a macro that types a harmful command when you press its key, or one that taps the Windows key alone.
- Agent shows a notice after each save by the assistant.
- **Not tested on a keyboard:** unplugging during a save, and pairing a dongle or Bluetooth device while the assistant's changes are waiting. Agent should keep the pairing unsaved until you review.
- To go back, open **Configuration** under **Device** and click **Restore** next to an earlier entry in **Configuration history**. An entry exists only for a configuration saved from Agent on this computer.

Regenerating the token or turning AI access off turns this setting off.

## Privacy and the access token

- Text macro contents are hidden from the assistant unless you tick **Let AI read text macro contents**. Leave it off if a text macro holds a password.
- The token is stored in plain text in the assistant's configuration: `~/.claude.json` for Claude Code, `~/.codex/config.toml` for Codex. Anyone who can read those files can read your configuration and propose changes while Agent runs. They can also save to the keyboard if you let AI clients save.
- **Regenerate token** disconnects every connected assistant. Afterwards, copy the new command or entry and connect again.

## If something goes wrong

- **Agent shows an update page for Agent itself, not the firmware:** a newer Agent saved the keyboard's configuration in a format this branch cannot read. Do not restore or reset anything. Quit, use the Agent you had before, and report it.
- **Agent shows an Update firmware page:** see [What you need](#what-you-need). Updating changes the keyboard's firmware, so the person decides.
- **Agent does not find the keyboard:** quit every other copy of Agent, including one in the system tray, then start this one again.
- **The assistant has no `uhk-agent` tools:** check that **Allow AI clients to read your configuration and propose changes** is ticked and Agent is running, then start a new assistant session.
- **The assistant gets an authentication error:** the token was regenerated. Copy the command or entry again.
- **`save_to_keyboard` is refused:** the reply says why. If it names changes, the person saves them in Agent. If it says there are no unsaved changes, they were already saved.
- **A save replies `failed` or `unknown`:** the keyboard may have been written. Check the key, and restore an earlier configuration if needed.

## Differences from official Agent

This branch writes configuration format 15.0.0, which released firmware reads, so it leaves out two newer settings from Agent's development branch: touchpad drag style and module angle. Everything else matches Agent's development branch plus the AI access feature.

## For coding assistants

- Check `node --version` before building; `npm run build` fails on versions outside the range above.
- `npm run electron` starts a desktop app and does not return. Run it in the background or a separate terminal.
- Enabling AI access, letting AI clients save, reviewing, clicking Save to keyboard and pressing keys are for the person at the keyboard. Ask them to do these steps; do not try to click them yourself. Use `save_to_keyboard` only if they turned it on and asked you to save.
- After the person runs the connect command, the new MCP server's tools appear only in a new assistant session.
- Do not read or print the access token, or the files that hold it. The person connects you.
- Use only the MCP tools to change the keyboard. Do not run the scripts in `packages/usb`: they compete with Agent for the keyboard and skip its checks.
- Never edit or delete an existing macro, keymap or setting as a test. Use an empty key, and undo what you did.
- A `saved` reply proves that the keyboard accepted the configuration, not that it works. The person's key press is the test.
- Displays differ between models, so do not rely on `notify` or other display commands to check a save.

## Reporting problems

This fork has no issue tracker. Send problems to whoever shared this branch with you, with your keyboard model, firmware version, operating system, and what the assistant and Agent showed. On a model other than the UHK 80, results from `get_device_info` and `get_layer` are especially useful.
