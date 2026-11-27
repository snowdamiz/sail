# Secrets

T3 Code can read credentials from a secret provider, so the credential stays in your password
manager and T3 Code saves only a reference to it. Agents can also ask you for a secret in a
private card instead of in the chat.

The Secrets settings page is in preview and is not in every build yet. Secret requests from agents
work everywhere.

## Secret providers

1Password is the supported provider. You can connect it in two ways:

- **Service account (recommended, works across Desktop, Web, and Boats)**: Open
  **Settings → Secrets**, select **Add provider**, keep **Service account** selected, and paste a
  [1Password Service Account](./secrets-1password-service-account.md) token (`ops_...`). Sail stores
  the token in the server's private secret store (never in plain text in `settings.json`) and syncs
  it automatically between Sail Desktop and your paired personal Sail Web server. Connect once on
  either Desktop or Web and both work from then on.
- **Local CLI account (single machine only)**: Switch **Connection** to **Local CLI account** and
  enter the shorthand, sign-in address (without `https://`), or ID that `op account list` shows.
  This uses the locally signed-in [1Password CLI](https://developer.1password.com/docs/cli/) (`op`)
  on that machine and does not sync to remote servers.

Personal Sail Web servers deployed from the Sail Docker image bundle the `op` CLI automatically, so
no extra CLI setup is needed on the server.

## Use a secret reference

Credential fields in Settings, such as provider environment variables and credentials, source
control tokens, usage limit keys, and device host tokens, show a source picker next to the field.
Pick **Value** to save the credential itself, or pick a secret provider and enter a reference such
as `op://vault/item/field`. Copy the reference from 1Password with **Copy Secret Reference**.
Select the check button next to a reference to read it now. If it reads, providers that use it
start using the new value.

T3 Code reads the secret when it needs it, for example when a provider starts. Change the
credential in 1Password and refresh to use the new value.

## When a secret cannot be read

If 1Password is locked or signed out, the provider or feature that needs the secret shows an error
naming the secret provider. Unlock 1Password on the server's machine, then select **Refresh** in
**Settings → Providers**. T3 Code never replaces a saved credential it cannot read with another
login.

## Remove a secret provider

When you remove a secret provider in **Settings → Secrets**, T3 Code lists the fields that read
from it. Removing it clears those fields, so set them again before you need them. The secrets in
1Password are not touched.

## When an agent asks for a secret

An agent that needs a token or password shows a secret request card in the thread instead of asking
you to paste it into the chat. Type or paste the value and select **Save securely**, or select
**Decline**. You can answer from web, desktop, or mobile.

If the environment has a secret provider, the card also lets you pick it and enter a reference
instead of the value. Answering with a reference needs permission to manage providers, as saving a
reference in Settings does; a session without it sees only the value field. T3 Code reads the
secret once, when you answer. If 1Password is locked, the card says so and the request stays open:
unlock it and try again, or enter the value.

The value never appears in the conversation. Most requests keep it from the agent too: T3 Code
passes it to the tool that needs it. When an agent has to run a command with the value, the card
says so instead: the value goes into a private file that the agent's commands can read for about 24
hours.

## Project credentials and Boats

Connect 1Password once with a Service Account token on either Sail Desktop or Sail Web, then
authorize credentials for a project in **Settings → Secrets** under **Project credentials** (either
by linking an existing `op://vault/item/field` reference or by saving a new credential directly to
1Password). Authorized credentials also match by git repository remote so the same project works
seamlessly on both Desktop and Web.

Each project credential can specify an optional environment variable name (such as
`AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`) and an **Auto-use** toggle (enabled by default):

- **Automatic session & terminal environment**: Auto-use credentials with an environment variable
  are injected directly into agent sessions and integrated terminals for that project.
- **Automatic secret requests**: When an agent calls `request_secret` (single-value or
  multi-field) matching authorized project credentials, Sail fulfills the request automatically
  without blocking on a prompt card.
- **Automatic sync to Boats**: When a project is cloned onto a Sail Boat (or when a Boat wakes,
  or when you add/edit/revoke a project credential), Sail pushes **only that project's authorized
  credentials** over the Boat's authenticated control channel into the Boat's private server secret
  store. Your 1Password Service Account token and other projects' credentials are never copied to
  the Boat. Revoking or turning off **Auto-use** for a credential immediately removes it from
  running Boats (and from sleeping Boats on next wake).

You can also authorize credentials directly from any single-value or multi-field secret request
card (including on a Boat) by checking **Also save in 1Password for this project**. Sail creates a
single 1Password item on your managing Sail host, authorizes the project, fulfills the active
request, and syncs the scoped credentials to the Boat for future sessions.
