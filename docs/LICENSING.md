[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Licensing and redistribution

# License inventory and release review

Agent Baton itself is distributed under the [MIT License](../LICENSE). The `package.json` runtime dependency set is empty. Installer vendoring copies the CLI entry point (`bin/`), internal modules (`src/`), and generated-agent source templates (`templates/`) into an installed project's `.baton/runtime/`. It also keeps `.baton/LICENSE` in all installs (including `--no-vendor`) and copies the upstream `LICENSE` file into `.baton/runtime/LICENSE` to preserve the MIT permission and warranty notice alongside redistributed source. Alias/symlink and hardlinked notice targets are rejected rather than followed. The host project's own root `LICENSE` is never modified.

## Inventory (source audit, 2026-10-13)

| Surface | Source | Distribution | Attribution obligation |
|---|---|---|---|
| CLI + internal modules | `bin/`, `src/` | npm tarball and installed vendored runtime | MIT notice accompanies both copies, plus `.baton/LICENSE` for generated adapters |
| Agent adapters, prompts, workflows | `templates/` and `templates/adapters.json` | npm package; rendered files in user repositories; templates also vendored in runtime | MIT source notice in vendored runtime; never overwrite the target project's own license |
| Documentation and illustrations | `docs/`, `assets/`, `README.md` | npm tarball (as configured) and repository | MIT project terms, subject to separately identified third-party contributions |
| Code of Conduct | `CODE_OF_CONDUCT.md` | Repository governance documentation | Adapted from Contributor Covenant 2.1, credited in file; verify upstream terms when reproducing or modifying |
| GitHub Actions used by this repo | `.github/workflows/` | Repository CI, not a runtime npm dependency | Verify each external action's license/security before pinning or release |
| Optional users' installed agent CLIs | Claude, Codex, Gemini and other user-supplied tools | **Not** bundled or relicensed by Baton | Governed by their own licenses/accounts and separate from Baton's MIT code |

This is a source-level inventory, **not** a legal certification or exhaustive third-party copyright scan. Do not assume every new PR or imported prompt/image is automatically MIT-compatible. Maintainers must review the provenance of newly committed assets, examples and code.

## Release checklist

- [ ] Confirm `package.json` metadata, version, runtime dependency list and MIT `LICENSE` are consistent.
- [ ] Run `npm pack --dry-run --json` and verify the archive contains `LICENSE`, `README.md`, the entrypoint, necessary `src/` and `templates/` files; review for secrets, unsupported dependencies and unrelated artifacts.
- [ ] Use `collectRuntime()` or `baton init` in a throwaway directory and confirm `.baton/runtime/LICENSE` is byte-for-byte the source MIT notice.
- [ ] Confirm an existing host repository's `LICENSE` is preserved by install, upgrade and uninstall. If an upgrade introduces the vendored license, treat it as a new managed file, not permission to replace the host's legal terms.
- [ ] Inventory imported code, dependencies, templates, fonts, screenshots, datasets, artwork and generated text for third-party notices, usage restrictions and compatibility.
- [ ] Review whether a `NOTICE` file is needed for any newly imported attribution-requiring material; none is automatically assumed here.
- [ ] Record review ownership and any exceptions in the release PR, and keep the original notices with any substantial copied code.

This policy addresses BAT-086 and complements [CONTRIBUTING.md](../CONTRIBUTING.md) and the [security model](SECURITY_MODEL.md).
