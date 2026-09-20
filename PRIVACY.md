# Privacy and release boundary

This is an independent checkout with no imported Git history. Runtime code was
extracted selectively; original private fixtures and regression tests remain
in the consuming project. The tests here were written using synthetic values.
Comments and command-help examples were reviewed for private research details.
Family-specific default queries and identifiers were replaced by explicit
caller-supplied controls. No data export, captured research page, credential,
account configuration, browser profile or original commit was copied here.

The npm package allowlist contains runtime source, the CLI, README, this file
the MIT license and package metadata. The release audit checks exact repository and package
file lists, rejects symlinks and unexpected files, and checks a few secret/path
patterns. `prepack` runs tests and that audit. These checks constrain the file
boundary; they do not prove that arbitrary text is anonymous.

Before publication:

1. Review every new file, including comments, help text, tests and filenames.
2. Compare locally against private names, record IDs, contact details and
   research identifiers. Keep the denylist and audit logs in the private project.
3. Inspect the actual archive and verify it matches the reviewed source.
4. Review every Git commit and its author metadata. Never import private
   repository history, remotes, hooks or automation configuration.
5. Keep the MIT license in the release. Remove the npm `private` guard only for an intentional
   npm release; GitHub visibility is a separate decision.

Tests must run without live accounts or paid requests. A parser test may invent
a result page; it must not copy a saved family research page. Synthetic controls
in tests are not usable live known-positive controls. Production controls must
be explicitly supplied by each consumer and never bundled with this package.

Code consumes personal information supplied by the caller, and research commands
send queries to archive sites. This package is not an anonymizer. Captures,
exports, error transcripts and browser sessions must be handled as private by
the consumer. Packaging guards protect the tool distribution, not user output.
