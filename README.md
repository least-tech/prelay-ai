# Relay

Relay turns recurring AI work into versioned workflows and measures the staff time and recorded AI usage needed to approve a result. The default workflow localizes campaigns into English, Traditional Chinese, Simplified Chinese, and Korean. The pilot supports pasted output from any tool and optional in-app generation with OpenAI. Set APP_NAME to brand the interface.

## Stack and deployment scope

Node.js 24.22.3 LTS, server-rendered JavaScript, SQLite, and built-in invite-only email/password authentication. The app has zero third-party packages and uses the SQLite module built into Node. This choice lets the full auth, database, and review flow run on one pinned runtime, including environments without a package registry or Docker. Deploy the included Dockerfile as a single instance with a persistent volume. A stateless Vercel function deployment cannot provide the persistent writable disk this build uses.

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

There is no OAuth, external SMTP, public sign-up, or auth callback URL. APP_ORIGIN is the one allowed browser origin and the base of invite links. The sign-in URL is APP_ORIGIN/login and the invite URL is APP_ORIGIN/join#<code>. Set APP_ORIGIN to the exact published HTTPS origin in production, with no path. Always share links on that domain. Authenticated users land on /workflows after sign-in. New pilots enter their invited email and choose a password. Existing accounts enter their existing password. The link is a single-use bearer credential bound to the intended email identifier. Its recipient can create an account for that email, so send the link directly to the intended person. There is no automated recovery email. Sessions last up to seven days.

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

Lint checks syntax and source whitespace. The typecheck command checks the strict SQLite schema and type contracts at the persistence boundary. Tests exercise runtime request/CSV validation and use fresh SQLite databases and in-process HTTP request/response streams to exercise the real handler without a listening network port. The standard suite needs no accounts, keys, browser, or external services. For an explicit real OpenAI call, configure .env and run npm run test:live-ai. GitHub Actions runs install, lint, type contract checks, tests, and release packaging on push and pull request.

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
