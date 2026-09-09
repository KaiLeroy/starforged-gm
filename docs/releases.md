# Release process

1. Update `version` in `package.json` and `package-lock.json`.
2. Run `npm run verify` and `npm run playtest` locally.
3. Open a pull request and wait for the Linux verification, dependency policy, and native Windows packaged-app smoke jobs.
4. Merge the tested commit.
5. Create a `v<package-version>` tag on that commit.
6. The release workflow verifies the tag/version match, reruns the required gates, builds the Windows installer, and publishes through GitHub Releases.

## Artifact identity

The Electron application ID is `io.github.kaileroy.starforgedsologm`. Windows artifacts use a stable product/version/architecture filename.

Windows code signing is not configured yet. Public releases should document that limitation and publish checksums. Before presenting the installer as trusted software, configure a protected signing certificate in CI and remove `signAndEditExecutable: false`. SBOM and provenance attestation are recommended follow-up release controls.

