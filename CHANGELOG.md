# Changelog

## 0.4.1 - 2026-10-29

### Fixes

- Fix `browser_read` failing with `INVALID_TOOL_OUTPUT: value is not lossless JSON`
  by omitting unavailable optional fields instead of returning `undefined` values.
- Preserve readable output for titleless HTML and responses without Content-Type,
  including structured HTTP and transport failures.

### Development

- Add lossless-JSON regression tests at the tool execution boundary.
- Add GitHub Actions checks for pull requests and pushes to master: type checking,
  host/client builds, and the complete test suite using Node 24 and the declared pnpm version.

Compatibility is unchanged: DSH v0.2.0-rc.1 or later is required.

Thanks to @JohnHaixin5777 for the fix and @3338682145 for the original report
(issues #2 and #3; pull requests #4, #5, and #6).

## 0.4.0 - 2026-10-02

### Compatibility

- Migrate browser settings and review submission to DSH's current ConfigForms,
  Session Controller, and UI Session services.
- This release requires DSH v0.2.0-rc.1 or later with volatile Config and ConfigForms APIs. Keep 0.3.0
  for deployments using the previous SettingsScope API.

### Fixes

- Restore the browser settings page by exposing all nine live Config fields.
- Apply accepted settings to routes, tools, update checks, and agent guidance
  without restarting the plugin.
- Save staged setting changes in one atomic mutation and retain rejected drafts.
- Dispose the settings subscription when the client plugin unloads.

### Development and documentation

- Separate host, client, and test type checks to avoid conflicting service types.
- Pin the published SDK dependencies and declare the new service packages so
  builds do not rely on local source links.
- Add regression coverage for configuration projection, live updates, atomic
  saves, and settings-page recovery.
- Update both READMEs to describe profile-backed configuration and inheritance.

Validation: type checks, dual-face build, and all 218 tests pass.
