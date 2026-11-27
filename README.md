# Relay

Relay helps individuals and teams audit AI spend, see which tasks consume time and tokens, and find what to optimize or automate. The existing workflow tools turn recurring tasks into versioned workflows and measure the staff time and recorded AI usage needed to approve a result. The default workflow localizes campaigns into English, Traditional Chinese, Simplified Chinese, and Korean. The pilot supports pasted output from any tool and optional in-app generation with OpenAI. Set APP_NAME to brand the interface.

## Usage audit

Open the homepage, sign in, and choose a source. The public sample report demonstrates both Free and Full with fictional data. The live application keeps reports private to the account that imported them, including within shared workspaces.

| Source | Free headline figures | Membership detail |
| --- | --- | --- |
| **OpenAI API** | Billed organization cost, completion tokens, model requests, last 30 complete UTC days | Daily activity, model and cache mix, billed line items, and model-routing tests to try |
| **ChatGPT history** | Prompt count, visible text-token estimates, elapsed response intervals where timestamps support them | Topic and prompt breakdown, prompt rewrites, models to test, and automation opportunities |
| **Request logs** | Recorded USD cost, tokens, request count, and active human time or latency when present | Recorded metrics by topic and prompt, standard-rate routing comparisons, prompt revisions and automation candidates |

An organization owner creates a dedicated key under [OpenAI Admin API keys](https://platform.openai.com/settings/organization/admin-keys). The server uses it in memory for the Usage and Costs calls, discards it after import, and stores only the resulting snapshot. Revoke the key after import. OpenAI bills [ChatGPT and API usage separately](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform). An API key cannot read ChatGPT web history. For that source, [request a ChatGPT export](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data), extract the ZIP and import its conversation JSON. The current implementation reads the active branch, estimates visible text tokens from character counts, and uses available message timestamps for response intervals. Provider latency, human time and per-prompt ChatGPT subscription cost are unavailable from that export.

For measured prompt-level reporting, upload a JSON array with `event_id`, ISO-8601 `timestamp` with timezone, `prompt` and `model`. Optional fields are `topic`, `input_tokens`, `output_tokens`, `cost_usd`, `latency_ms`, `active_ms` and `public_data`. The app provides a downloadable sample. Imports process up to 25 MB and 5,000 requests per source. A new import replaces the previous one for that source. The report stores derived aggregates and up to 50 ranked prompt excerpts of up to 1,600 characters, plus candidate workflow examples. Raw uploads are discarded after processing, and no prompt data is sent to model providers for this analysis. Users can delete snapshots. Configure a private encrypted disk and restricted backups, and avoid request-body logs at every proxy.

Suggestions are rule-based. [Current OpenAI Standard rates](https://developers.openai.com/api/docs/pricing) power supported text-routing estimates, with Luna used as a candidate for bounded tasks, Sol for everyday tasks and Astra for complex tasks. Same-token price comparisons omit caching, tooling overhead and quality changes. [Gemini Free](https://ai.google.dev/gemini-api/docs/pricing) is suggested only for suitable tasks and verified public or synthetic inputs. The product neither reroutes calls nor creates and executes agents.

## Custom-domain launch

1. On a Docker host with inbound ports 80 and 443, point the domain's A record to the host. Configure AAAA only if the host has reachable IPv6. For the included automatic TLS setup, start with a DNS-only record.
2. Copy `.env.example` to `.env`, restrict its permissions, and set `DEPLOY_DOMAIN` to the domain without a scheme. Compose sets `APP_ORIGIN` to the corresponding HTTPS origin. If using another host, set `APP_ORIGIN`, `NODE_ENV=production`, `HOST=0.0.0.0` and the persistent SQLite path directly.
3. For your own account on a fresh volume, set `BOOTSTRAP_ON_START=1`, `BOOTSTRAP_EMAIL` to your email, `BOOTSTRAP_PASSWORD` to a unique password of at least 12 characters and `BOOTSTRAP_AUDIT_TESTER=1`. Run `docker compose up --build -d`. Once you can sign in, remove the password and disable bootstrap, then rerun `docker compose up -d`.
4. On an existing deployment, grant preview to an account you control with `docker compose exec app node scripts/admin.mjs audit-tester YOUR_EMAIL grant`. For local development, use `node --env-file-if-exists=.env scripts/admin.mjs audit-tester YOUR_EMAIL grant`. The same command with `revoke` removes preview access.
5. Open `https://YOUR_DOMAIN/audit`. Import a source and use **Tester preview → Free / Full / Actual plan**. Both previews use the same private audit data and bypass payment only for the explicitly granted account. Check `/healthz` and verify the Free view omits prompt details.
6. Enable open registration with `AUDIT_PUBLIC_SIGNUP=1` when ready. The pilot has no email verification or automated password recovery, so provision the operator's account before opening registration. Keep SQLite on the persistent volume and deploy a single application replica. Back up the database privately.

### Enable paid checkout

Create two recurring Stripe Prices for the same membership, USD $12 each month and USD $99 each year. Configure `STRIPE_SECRET_KEY`, `STRIPE_MONTHLY_PRICE`, `STRIPE_ANNUAL_PRICE` and `STRIPE_WEBHOOK_SECRET`. Enable Stripe's customer portal and allow cancellation and, if desired, switching between the two prices. Register `https://YOUR_DOMAIN/billing/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused` and `customer.subscription.resumed`.

Run the end-to-end test in Stripe test mode first. On the report, use **Actual plan**, start checkout and confirm that the signed webhook unlocks Full. Use the billing portal to cancel and inspect the resulting entitlement. When switching to live mode, use the corresponding live keys and live IDs with a fresh database or a separate production installation. The app checks price, currency and renewal interval before creating checkout. A success URL alone cannot unlock a report.

### Pricing and the path to $10M ARR

| Planning input | Target / example |
| --- | ---: |
| Monthly and annual self-serve pricing | $12 / $99 |
| Annual mix assumption | 65% |
| Blended annual revenue per payer | $114.75 |
| Active payers for $10M ARR | 87,146 |
| Blended monthly payment cost assumption | $0.40 per payer |
| Infrastructure, storage and support allowance | $1.25 per payer-month |
| Illustrative contribution margin | 82.8% before acquisition and fixed overhead |
| Paid acquisition target | $45 or less per payer, about 5.7 months of contribution |
| Replacement demand at 4% effective monthly churn | About 3,486 new paying subscriptions per month just to maintain the base |
| Free-to-paid conversion assumption | 5%, about 69,720 qualified reports per month for replacement volume |

The $99 annual price saves 31% versus 12 monthly payments. [Langfuse Core](https://langfuse.com/pricing) starts at $29 per month and targets instrumented observability. Relay sells a personal usage audit and optimization report that also works with a ChatGPT export. The forecast uses illustrative payment fees of 2.9% plus $0.30 per transaction, before additional Stripe Billing charges, FX, tax, disputes, and free-user acquisition and hosting. Contribution and churn are targets, not results. Zero paid inference per report keeps compute costs predictable. Track import success, report-to-paid conversion, repeat imports, churn and verified savings before scaling acquisition. The scale target will require more storage and capacity than the single-instance launch deployment.

## Stack and deployment scope

Node.js 24.22.3 LTS, server-rendered JavaScript, SQLite, and built-in email/password authentication with invite-only and public registration modes. The app has zero third-party packages and uses the SQLite module built into Node. This choice lets the full auth, database, and review flow run on one pinned runtime, including environments without a package registry or Docker. Deploy the included Dockerfile as a single instance with a persistent volume. A stateless Vercel function deployment cannot provide the persistent writable disk this build uses.

## Run locally

Install [Node.js 24.22.3](https://nodejs.org/en/download/archive/v24.22.3), then run these commands from the directory containing this README:

~~~bash
npm ci --offline --no-audit --no-fund
cp .env.example .env
npm run migrate
~~~

Use Copy-Item .env.example .env in PowerShell. The defaults serve http://localhost:3000 and put the database under ./data/. A database migration also runs at startup, so restarts and upgrades apply any pending migration. Keep the release files under dist/ together when moving a built release.

### Bootstrap the first owner

Run once against a fresh database. Use a unique password of at least 12 characters. The bootstrap command refuses a second owner bootstrap. Replace the example workspace and email before use.

**Bash**

~~~bash
export BOOTSTRAP_EMAIL='owner@example.com'
export BOOTSTRAP_WORKSPACE='My Pilot Workspace'
read -rsp 'Owner password: ' BOOTSTRAP_PASSWORD
export BOOTSTRAP_PASSWORD
printf '\n'
npm run bootstrap
unset BOOTSTRAP_PASSWORD
# Optional. Installs one separate, repeat-safe fictional workflow.
npm run seed
unset BOOTSTRAP_EMAIL BOOTSTRAP_WORKSPACE
npm run dev
~~~

**PowerShell**

~~~powershell
$env:BOOTSTRAP_EMAIL = 'owner@example.com'
$env:BOOTSTRAP_WORKSPACE = 'My Pilot Workspace'
$relayPassword = Read-Host 'Owner password' -AsSecureString
$env:BOOTSTRAP_PASSWORD = [System.Net.NetworkCredential]::new('', $relayPassword).Password
npm run bootstrap
Remove-Item Env:BOOTSTRAP_PASSWORD
$relayPassword.Dispose()
# Optional fictional walkthrough dataset.
npm run seed
Remove-Item Env:BOOTSTRAP_EMAIL, Env:BOOTSTRAP_WORKSPACE
npm run dev
~~~

With a portable Node binary that lacks npm, run node --run migrate, node --run bootstrap, node --run seed, and node --run dev as equivalents. This project has an empty dependency tree. The optional sample can also be loaded by an owner from Workspace Settings → Fictional walkthrough. It has its own results and is excluded from workspace-wide usage summaries.

Open http://localhost:3000/login with the bootstrapped credentials. In **Workspace Settings → Pilot invites**, enter the pilot's email and expiry in days. Copy the generated link and send it privately. The raw link is shown at creation. Revoke it from Settings and generate another if you need to resend it.

### Authentication and public URL

There is no OAuth, external SMTP, or auth callback URL. Public registration is optional (set AUDIT_PUBLIC_SIGNUP=1). It does not establish ownership of the supplied email address. APP_ORIGIN is the one allowed browser origin and the base of invite links. The sign-in URL is APP_ORIGIN/login and the invite URL is APP_ORIGIN/join#<code>. Set APP_ORIGIN to the exact published HTTPS origin in production, with no path. Always share links on that domain. Authenticated users land on /audit after sign-in. Workspace invite acceptance still opens /workflows. New pilots enter their invited email and choose a password. Existing accounts enter their existing password. The link is a single-use bearer credential bound to the intended email identifier. Its recipient can create an account for that email, so send the link directly to the intended person. There is no automated recovery email. Sessions last up to seven days.

## Five-minute pilot walkthrough

1. Open your invitation in a browser, enter the email it was sent to, choose a password, and click **Join workspace**. Use that same email and password to sign in again.
2. Open **Workflows → Campaign localization**. Add a short campaign, its audience, brand tone, and any terms that must stay exact. Select English, Traditional Chinese, Simplified Chinese, or Korean.
3. If **Generate with OpenAI** is available, click it. Otherwise, **Copy prompt for an external AI tool**, use it in your usual AI tool, then paste the answer, select the tool, and click **Save pasted output**. You can paste a previously generated answer as well.
4. Edit the result and check the dates, prices, and offer terms. Use **Request changes** with a note if another pass is needed. When it is ready, enter the total active staff minutes across prompting, editing, and review. Confirm them or mark time unavailable, then click **Approve**. Copy or download the approved text.
5. Open **Results**, select the workflow, and check the approved result, active time, revisions, and usage coverage. If you have usage telemetry, copy the run ID from the review page and import the CSV there in Results.

Save an example under **New workflow** to draft instructions using formatting and style cues, or leave examples empty to use the standard template. Retaining the raw examples is optional. Open **Versions** to save a new version. On an existing run, use **Compare versions** to reuse its inputs against a second version, review both outputs side by side, and publish the one you prefer. If pasting, generate the second output externally with that version's instructions. **Duplicate workflow** copies the published instructions. Change the duplicated instructions for the next recurring text task.

## Measurement and usage

- Owners enter one baseline per comparable prior job in Workspace Settings. Use the same workflow and collect comparable measurements. Blank measurements remain unavailable and are excluded only from calculations that require them.
- Active time is self-reported total staff effort. Revisions count submissions that edit the output or request changes, counting a submission that does both once. First-pass approval is the share of reviewed jobs with a known revision count that were approved with zero revisions. Active time and elapsed time averages use approved jobs with a measured value. Elapsed time starts on executing an in-app run or saving an external draft. Comparison runs contribute to usage reporting but are excluded from pilot outcome metrics. Results show the latest 500 pilot runs and baseline jobs separately and summarize the latest 1,000 usage events for the chosen usage scope.
- In-app usage captures the exact reported model ID, available tokens, and request latency. Add a rate in **Workspace Settings → Model rates** using that exact ID, expressed as USD per million tokens. Rates apply when usage is captured. Recorded cost per approved result includes only runs for which every recorded event has a cost. A subtotal with unknown events is shown as partial on the run table. Unmetered hosted chats show unavailable cost. Estimates use simple input/output rates and may differ from invoices that use cache discounts or other pricing tiers.
- The app allows one OpenAI provider key per installation via OPENAI_API_KEY. The API request uses store:false. Prompt content is sent to OpenAI when Generate is selected. Set OPENAI_MODEL to a Responses API model your key can use. The app enforces persistent UTC-day call quotas per workspace and installation, caps input field sizes and model output tokens, and applies a 40-second provider timeout. Failed provider attempts count towards the quota. Pasting, reviews, exports, and reporting remain usable without a key.

### CSV input

In **Results → Import usage CSV**, choose a UTF-8 file or paste its contents. Include this header and replace the fictional run ID with the ID shown on your actual run:

~~~csv
run_id,agent,prompt_category,model,input_tokens,output_tokens,latency_ms,cost_usd,event_id
00000000-0000-4000-8000-000000000000,localizer,translation,gpt-4.1-mini,1000,450,1260,0.0012,provider-call-001
~~~

The first seven columns are required in any order. Agent and prompt category can be blank, as can unknown token counts and latency. Values for tokens and latency must be nonnegative integers. cost_usd is optional and is tagged **imported** when supplied, including zero. An exact model rate and both token counts yield an **estimated** cost when the cost cell is blank. event_id is optional and should be a stable provider call identifier when available. Include separate event IDs when distinct calls have identical values. Keep the same IDs on re-export. When an ID is omitted, deduplication uses normalized row values. Deduplication is scoped to the workspace and run. Reuse the same run for a given event. One bad row rejects the entire batch and changes no totals. Maximum 500 rows and 110,000 characters per batch. Owners can import for all runs in their workspace, members for their own runs. Imported event IDs are independent of Relay's in-app metering, so import external telemetry only.

## Access and data

| Action | Permission |
| --- | --- |
| Join | Valid, unrevoked, unexpired invite for the account email |
| Read workflows, runs, approved exports, results, team directory | Current workspace member |
| Create or duplicate workflows, run, import own telemetry | Current workspace member |
| Create, compare, publish versions or delete retained examples | Workflow creator or workspace owner |
| Review, approve, or delete a run | Run author, workflow creator, or workspace owner |
| Manage invitations, baselines, model rates, seed data or import for other users | Workspace owner |

Every request resolves the active workspace from a hashed session and membership. Resource lookups scope by workspace before dependent reads or writes. The database is reachable only by the server. Versioned migrations under migrations/ enforce foreign keys, uniqueness, strict column types, and comparison boundaries. The server enforces per-role policies in src/auth.mjs, src/app.mjs, and src/work.mjs. POST requests require the configured origin and production cookies are Secure and HttpOnly. Passwords use salted scrypt. Invite tokens and session identifiers are stored as digests. Request paths with invites carry the token in the URL fragment so it is not sent in HTTP requests. Store backups on private encrypted storage and enforce your retention policy on those backups.

**Delete example** removes the retained example from the workflow. Derived style cues do not embed verbatim source content. If someone manually copies examples into instructions, delete or redact that copy at the data-store level with the operator's help, taking database and backup retention into account. **Delete run and output** removes its saved input, original and edited/approved content, usage, and linked comparison runs. Archived/backed-up copies follow the volume backup retention. Raw inputs, examples and content are used for the app's private records, not application analytics or logs. For operational monitoring, log health status and request counts without bodies, cookies, or full headers.

## Test and build

~~~bash
npm run lint
npm run typecheck
npm test
npm run build
npm start
~~~

Lint checks syntax and source whitespace. The typecheck command checks the strict SQLite schema and type contracts at the persistence boundary. Tests exercise runtime request/CSV validation and use fresh SQLite databases and in-process HTTP request/response streams to exercise the real handler without a listening network port. The standard suite needs no accounts, keys, browser, or external services. It mocks OpenAI and Stripe and tests access to private snapshots and the tester preview. For an explicit real OpenAI call, configure .env and run npm run test:live-ai. GitHub Actions runs install, lint, type contract checks, tests, and release packaging on push and pull request.

## Push the extracted source to GitHub

For a new, empty repository created on GitHub:

~~~bash
git init -b main
git add .
git commit -m "Initial Relay pilot"
git remote add origin https://github.com/YOUR-ORG/YOUR-REPO.git
git push -u origin main
~~~

For an existing repository with commits, clone it first, create a branch, and copy the extracted source into the intended repository root. Review conflicts before replacing any existing files. Then run:

~~~bash
git switch -c relay-pilot
git add .
git commit -m "Add Relay pilot"
git push -u origin relay-pilot
~~~

Open a pull request to merge the pilot branch. If your repository layout calls for a subdirectory, adjust both the CI workflow's working directory and the host's service root.

## Deploy from GitHub on Railway

1. In Railway, connect your GitHub repository as the service source and select the intended branch. The host detects the root Dockerfile. Configure one replica.
2. Attach a persistent volume at /data and enable private backups. The SQLite database must be on this volume. Configure networking for a public HTTPS domain, app port 3000, and healthcheck path /healthz.
3. Set these service variables. The Docker image already provides the listed NODE_ENV, HOST, PORT and DATABASE_PATH defaults. Railway needs the UID override for its root-mounted volume. The entrypoint transfers /data ownership to the node user and drops privileges before the app starts.

~~~dotenv
NODE_ENV=production
APP_ORIGIN=https://YOUR-RAILWAY-DOMAIN
HOST=0.0.0.0
PORT=3000
DATABASE_PATH=/data/relay.sqlite
RAILWAY_RUN_UID=0
BOOTSTRAP_ON_START=1
BOOTSTRAP_EMAIL=owner@example.com
BOOTSTRAP_PASSWORD=YOUR-UNIQUE-LONG-PASSWORD
BOOTSTRAP_WORKSPACE=My Pilot Workspace
~~~

4. Deploy, wait for /healthz to return ok, and sign in at /login. Remove BOOTSTRAP_ON_START and BOOTSTRAP_PASSWORD from service variables after the first sign-in. The owner persists on the volume.
5. Send yourself a test invite under a different email and verify the flow using a private browser session. Test a redeploy before inviting users to confirm persistence. If you enable OpenAI, add OPENAI_API_KEY as a server secret, then perform a fictional generation and confirm the usage entry. Start with the documented quotas or lower limits for your pilot.

Other hosts can use the same Dockerfile with a persistent writable /data mount, TLS termination, and one replica. Set the same APP_ORIGIN, port and bootstrap variables as appropriate. For local containers, use the direct Node setup above if you do not have HTTPS termination. A production app intentionally requires an HTTPS APP_ORIGIN. Ensure the launch system allows outbound HTTPS to api.openai.com if enabling generation.
