# CCM playground workspace

This directory is a seeded project inside the playground container HOME.
It is not the host git checkout.

The app here uses `tests/fixtures/fake-claude.sh`. Sending a chat message
will not complete an agent turn; the session may stay busy until
`npm run playground:restart`. Use `npm run playground:up:mock` for send/stream UI.
