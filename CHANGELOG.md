# Changelog

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
