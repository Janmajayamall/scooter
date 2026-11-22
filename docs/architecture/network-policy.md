# The network policy

pi's VM has no network of its own. Gondolin's host side, inside the runner's process, handles everything the VM sends, and the network policy is the runner's rules for it: which hosts it may reach, where the OpenRouter key goes, what may be asked of OpenRouter, and zero data retention. The policy logs every request in the network log, which the runner, the bridge and the owner read. The policy is the sandbox's network for every run ([the sandbox](sandbox.md)). Where the key is kept, and what reaches what, are in [Secrets](../ARCHITECTURE.md#secrets) and [The network](../ARCHITECTURE.md#the-network); the owner's choices it keeps, in [The owner's fixed choices](../ARCHITECTURE.md#the-owners-fixed-choices).

## Files

- `src/runner/sandbox/policy.mjs`: the policy, `policyNetwork`: hosts, the key, OpenRouter's two routes and their checks, the body that goes out, zero data retention, the internet switch, and what one run may send.
- `src/runner/sandbox/netlog.mjs`: writing the log, and following each request the policy lets out to its answer.
- `src/common/netlog.mjs`: the log's format, its check, and its reader, for the runner and for `scooter status`.

## Settings

In `runner.env`:

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | required | The key the runner swaps in on pi's requests to OpenRouter ([The key](#the-key)). It never enters pi's VM |
| `OPENROUTER_ZDR` | `on` | `on` sends every request to OpenRouter only to endpoints that keep no prompts or responses ([Zero data retention](#zero-data-retention)) |
| `AGENT_INTERNET` | `off` | `on` lets pi reach public HTTPS websites through the policy, which logs every request ([Hosts](#hosts)). The prompt tells the agent which ([The prompt](runner.md#the-prompt)), and `scooter status` shows it, from `status.json` ([status.json](runner.md#statusjson)) |

`AGENT_INTERNET` is the runner's setting alone. *Why:* the bridge's side needs to know it only for `scooter status`, and a second copy in `bridge.env` could disagree with the one the runner uses.

## The VM's network

- **DNS** is answered inside the runner with made-up addresses, so lookups never leave the machine and can't carry data out.
- **UDP, raw TCP and private addresses** are refused: loopback, link-local, cloud metadata, LAN, VPN and container ranges, including through DNS tricks and redirects.
- **HTTP(S)** goes out only to allowed hosts, through Gondolin's own client. The runner terminates the VM's TLS with its own certificate authority, which the image trusts, so it sees each request in full before passing it on.

`openGondolinSandbox` takes `policyNetwork({ paths, clock, log })` as its network unless a test gives another. For each run it makes a new placeholder for the key, `scooter-openrouter-api-key-placeholder-<48 hex digits>`, which it gives to Gondolin as the secret's placeholder and to the policy, so the hook knows what the VM sees; and it closes the run's network once the VM has closed, on every path. *Why its own placeholder:* Gondolin's own could be read back only once the hooks were made, and Gondolin checks one it is given as it checks its own. The VM's `maxHttpBodyBytes` is `MODEL_REQUEST_MAX_BYTES`: Gondolin answers a longer body, to any host, with 413 before the policy sees it, so nothing of it goes out and nothing is logged, and a run that ends on one reads as pi's own failure.

## Hosts

- **`openrouter.ai`**, exactly, over HTTPS, and only by its two routes ([Requests to OpenRouter](#requests-to-openrouter)).
- **With `AGENT_INTERNET=on`,** also any other host over HTTPS, on any port; Gondolin then refuses a private address, named or resolved. Off, the policy allows `openrouter.ai` alone.
- **Refused whatever the switch:** plain HTTP; OpenRouter's other hosts, `*.openrouter.ai`; and `openrouter.ai.`, with a dot at the end, which Gondolin's host patterns could take for `openrouter.ai` and send the key to. *Why:* OpenRouter is reached only by its two checked routes; without its other names refused, a request with internet access on could reach it past the checks.
- A method that isn't all capitals is refused: every method a tool uses is, and the log keeps no other.

*Cost of internet access:* with it on, a misled run can send the owner's data to any public website, and even an ordinary lookup tells a website what was looked up. The log shows when, which host and path, and how much, not what.

## The key

pi never holds the key. Gondolin swaps the run's placeholder in `OPENROUTER_API_KEY` for the real key only in requests to `openrouter.ai`, wherever it is in a header; anything else the VM sends carries only the placeholder, which is worthless outside the runner.

The policy lets the placeholder go only where pi sends it. On `openrouter.ai`, the key's header for the route, `x-api-key` on the messages route and `authorization` on the chat route, must be exactly the placeholder, `Bearer <placeholder>` on the chat route; the other key header must be absent; and no other header may hold the placeholder, nor any the key itself. To any other host, no header may hold the placeholder or the key. Each is refused with 403 and its own reason.

*Why:* a request with a key a misled agent found would get 401 from OpenRouter, which the runner reads as a setup error, and runs would pause for good ([Failures](run.md#failures)). The placeholder in another header, such as `X-Title`, which OpenRouter shows as the app's name, would have Gondolin put the key there. The key itself in a header is what a redirect from OpenRouter would carry to its next hop, which Gondolin hands to the policy again. Gondolin refuses the placeholder to another host too, but after the policy, with no line in the log.

## Requests to OpenRouter

An `onRequest` hook allows only `POST /api/v1/messages`, with no query string or with pi's `?beta=true`, and `POST /api/v1/chat/completions`, with none, on port 443. Anything else on `openrouter.ai` gets 403. The hook reads the whole body, up to `MODEL_REQUEST_MAX_BYTES`, since images go inline, decodes it as UTF-8 that must be valid, parses it, and answers 400, logging the reason but never the body, unless all of these hold:

- `model` is exactly the agent's configured model, so a misled run can't switch to another, more expensive one;
- the body has only the top-level fields, and the request only the `anthropic-beta` values, that the pinned pi sends on that route for any model of its catalog: on the messages route `max_tokens`, `messages`, `model`, `output_config`, `stream`, `system`, `thinking` and `tools`, with three `anthropic-beta` values; on the chat route `max_completion_tokens`, `messages`, `model`, `reasoning`, `store`, `stream`, `stream_options` and `tools`, with none ([What pi sends](#what-pi-sends));
- every tool is one pi runs itself: `type: "function"` on the chat route, and no `type` at all on the messages route, where a type names a server tool, such as `web_search_*`, `web_fetch_*` or `openrouter:*`;
- there's no `plugins` or `mcp_servers` field, refused by name, so the log says so;
- every block of a message, of a tool result or of the system prompt is a kind pi sends, or another inline medium, and every image or document is inline: on the messages route `text`, `image`, `document`, `tool_use`, `tool_result`, `thinking` and `redacted_thinking`, an image or document only with a `base64` source; on the chat route `text`, `image_url` with a `data:` URL, `file` with nothing but `filename` and a `data:` URL in `file_data`, and `input_audio`. Anything else, such as `video_url` or a `search_result`, is refused;
- a body with a `content-encoding` other than `identity` is refused, since it can't be read.

The hook then forwards its own encoding of what it checked, `JSON.stringify`, with `content-length` and `content-encoding` dropped, so a body with a duplicated key can't show the check one value and OpenRouter another.

*Why:* without these checks OpenRouter could fetch from the web for the agent, past the policy and its log ([Facts about OpenRouter](#facts-about-openrouter)). The allowlists are the union over pi's whole catalog, since one model's would refuse others a configured model could need, such as `interleaved-thinking-2025-05-14`, which `anthropic/claude-sonnet-4.5` sends; every value in it is one pi sends, and none has OpenRouter fetch anything. Kinds of content are allowlisted so that a new one that could make OpenRouter, or the model's provider, fetch a URL fails closed. Message fields and roles aren't checked: none fetches. *Cost:* every pi upgrade means capturing its requests again; and a thinking level milestone 0 didn't ask, or a model added to OpenRouter after pi 1.5.2, could send a field outside the union: its first request is then refused, and runs pause with the policy's reason ([Failures](run.md#failures)).

*Headers* other than the key's and `anthropic-beta` aren't allowlisted, and go to OpenRouter as the VM sent them: none is known to make OpenRouter fetch anything. The ones it reads of an app's, `HTTP-Referer` and `X-Title`, only name the app on its dashboard, and neither can hold the key or its placeholder. `Host` is written by the HTTP client from the URL the hook checked, whatever the VM sent. An allowlist of pi's headers would have to be captured again with every pi, for nothing it is known to stop.

## Zero data retention

With `OPENROUTER_ZDR=on`, the default, the hook sets `provider` to `{ "zdr": true, "data_collection": "deny" }` in every body it forwards, on both routes. pi sends no `provider` field, so a body with one of its own is refused as a field pi doesn't send: nothing of the agent's choosing reaches the routing. OpenRouter then routes the request only to endpoints that keep no prompts or responses. Each route has its own switch in the code (`ZDR_ROUTES`), so if the messages route turns out to refuse these fields, they are left out there, and the key's guardrail enforces ZDR on that route alone; whether it takes them is among the README's [Check on the first real run](../../README.md#check-on-the-first-real-run). With `OPENROUTER_ZDR=off`, the hook leaves routing to OpenRouter's settings.

- If the configured model has no endpoint that qualifies, OpenRouter refuses every request, so runs pause and the owner gets one notice with OpenRouter's reason ([Failures](run.md#failures)). There's no separate check at a start; `doctor` lists the model's qualifying endpoints ([doctor](install.md#doctor)).
- A request can only tighten OpenRouter's own settings, never loosen them, so the owner also enforces ZDR on Scooter's key, with a guardrail, as the README's [OpenRouter](../../README.md#openrouter) says. Then even a request without the flag can't reach an endpoint that keeps data.
- *Cost:* OpenRouter and the model's provider see what the messages hold while they process them, and keep none of it afterwards, except what OpenRouter's screening for child sexual abuse material flags.

## What a refusal answers

An error in OpenRouter's shape, `{"error":{"message":"Scooter's network policy refused this request: <reason>","code":<status>}}`: 403 for a host, a path, a method or the key; 400 for what the body or its headers hold; 500 when the policy itself fails, and 503 when the request's line can't be written, neither of which lets anything out. *Why:* pi prints an error it gets on stderr, where the owner and the logs can see why a run failed ([Facts about pi 1.5.2](agent.md#facts-about-pi-152)).

## The log

The runner appends to `runner/log/YYYY-MM-DD.jsonl`, the UTC date, one JSON line per event:

```jsonl
{"id":"20261109T155012041-0001","at":"2026-11-09T15:50:12Z","event":"request","host":"openrouter.ai","method":"POST","path":"/api/v1/messages"}
{"id":"20261109T155012041-0001","at":"2026-11-09T15:50:13Z","event":"response","status":200,"ms":812}
{"id":"20261109T155012041-0001","at":"2026-11-09T15:50:19Z","event":"end","sent":48211,"received":5340,"ms":7012}
{"at":"2026-11-09T15:51:02Z","event":"refused","host":"example.com","method":"GET","path":"/","reason":"host not allowed"}
```

- **`request`** is written before the request goes out, so nothing leaves without a line, even if the runner crashes. A request whose line can't be written doesn't go out.
- **`response`** is written when the status arrives, before the body, with `ms` to the status. *Why:* a run that ends while the model is still streaming then has OpenRouter's status in the log; written at the end of the stream, a run that timed out while the model streamed would read as an outage, and be tried every 30 minutes for good ([Failures](run.md#failures)).
- **`end`** follows when the body is over: `sent` and `received`, the bytes of the request and the answer on the connection, heads included, and `ms` from the request line, with a `reason` when the answer was cut short, the client's error code or `run_ended`. The bytes come from the connection, since undici says nothing of a body's size as it passes, and on a connection a request has to itself, as undici's are, they are the request's own.
- **`error`**, for a request that got no answer, has the request's `id`, `at`, `ms`, and a `reason`, a short code from Scooter's own code: the host couldn't be reached, such as `ECONNREFUSED`, the connection broke before a status came, `not_sent` for a request the policy let out that never reached the client, as when Gondolin couldn't resolve its host, or `run_ended` for one with no status when the run ended.
- **`refused`** is a request the policy refused, with its host, and its method and path when it has them, and the reason.
- **`unlogged`**, `{ at, event, refused }`, counts the refusals of a run past `RUN_REFUSALS_LOGGED_MAX`.

Lines hold hosts, paths without their query strings, statuses, byte counts and timings, never headers, bodies or query strings. A host is written in lower case, with any character but letters, digits and `._:[]-` written as a URL writes a byte, and cut at 253 characters, DNS's longest name. A path is cut at `NETLOG_PATH_MAX_CHARS`, and a reason at `REASON_MAX_CHARS`, with what the VM chose, such as a field's name, at its end, so every line fits within `NETLOG_LINE_MAX_BYTES`; a line the writer would make longer is an error, and no request goes out without its line. The format is `src/common/netlog.mjs`, and every line is checked strictly against it.

**What one run adds is bounded.** One run may make `RUN_REQUESTS_MAX` requests that go out; past them the policy refuses. A request is counted when it passes the check, before its body is read, and given back if it is then refused, so requests read at the same time can't pass the limit together. The run writes its first `RUN_REFUSALS_LOGGED_MAX` refusals one by one, and counts the rest in one `unlogged` line when its network closes. *Why:* a line a reader skips is a request the failure handling doesn't see, and a request that goes out has its line before it goes, so requests can't be counted instead of written; they are bounded instead. A run makes a request a turn, a few hundred at most in the longest run `agents.yaml` allows. *Cost:* a run past `RUN_REQUESTS_MAX` requests fails as pi's own failure.

**Following a request to its answer.** The hook writes the `request` line; what comes of the request is undici's, inside Gondolin, which the hook doesn't see, and an `onResponse` hook would hold back streaming ([Facts about Gondolin's network](#facts-about-gondolins-network)). So the hook sets a header of its own, `x-scooter-request`, holding the request's ID, on every request it lets out, in place of any the VM sent. The runner subscribes to `undici:request:create`, which undici publishes as it makes a request, before it has a connection, takes the header out of the request's list of headers, which undici writes only once it has a connection, and follows that request by undici's own object: `undici:client:sendHeaders` for the connection's byte counts, `undici:request:headers` for the `response` line, and `undici:request:trailers` or `undici:request:error` for the `end` or `error` line. When the run's network closes, what is left is written: `not_sent` for what never reached undici, `run_ended` for what was still waiting. *Why not match by method and URL:* a request Gondolin let out and then didn't send, as when a host doesn't resolve, would take the next request's answer, and two requests to one URL at once could swap; both lead the failure handling to the wrong status. Gondolin's `fetch` option, a hook that makes the request itself, would lose the guarded connection Gondolin makes only with its own client, which keeps a name that resolved to a public address from connecting to a private one. *Cost:* taking the header out reaches into undici's request, whose headers are a list of names and values in undici 6.28.0 (Node 22.23.2's), 6.29.1 (Gondolin's) and 7.30.2 (Node 24.22.3's), each checked by a test or a run; if a later undici keeps them otherwise, the header goes out as it is, an ID of no use to anyone, and the request has no answer in the log. The policy's tests would fail first.

**Reading it.** `scanNetworkLog` takes the lines whose `at` falls in a time window, counting its first second whole, across the UTC days the window spans, reading each day's file a piece at a time, so a day of any size costs the same memory. It takes a line only up to `NETLOG_LINE_MAX_BYTES`, and skips a longer one, part of a line at the end of a file, and a line that isn't one of the log's, counting them, so one bad line doesn't hide the rest. Three things read the log: the runner, for the cause of a failure ([Failures](run.md#failures)); `scooter status`, for its counts over `STATUS_WINDOW` ([scooter status](bridge.md#scooter-status)); and the owner ([README](../../README.md#reading-the-network-log)). It is backed up with the rest ([What a backup holds](backups.md#what-a-backup-holds)).

## What pi sends

Milestone 0 recorded what the pinned pi 1.5.2 sends, run with `--offline` in a VM, in `test/fixtures/pi-requests/`: one whole session on each route, with thinking, an image read, tool calls and a session (`messages.json` and `chat.json`), and one request for each of the 403 OpenRouter models in pi's catalog, at thinking unset, `off` and `high` (`catalog.json`). `test/tools/capture-pi-requests.mjs` writes them. The allowlists are taken from them, and a test compares the two.

- pi asks for nothing but the model's answers: no request to any other path or host, `GET /api/v1/models/user` included.
- **The messages route**, `POST /api/v1/messages?beta=true`, with the key in `x-api-key`, for 20 models: the 16 named `anthropic/claude-…` and the 4 aliases named `~anthropic/claude-…-latest`. Their `:batch` variants go to the chat route. Across the catalog it sends the 8 fields above, or the same without `output_config`, and its `anthropic-beta` header is one of three things: `mid-conversation-output-config-2026-07-01` and `thinking-binding-controls-2026-08-01`, which the default model sends on every turn, `interleaved-thinking-2025-05-14` alone, or absent. It adds a message with `role: "system"`, empty content and an `output_config` after each user turn.
- **The chat route**, `POST /api/v1/chat/completions`, with no query string and the key in `Authorization: Bearer`, for the other 383 models: `model`, `messages`, `stream`, `stream_options`, `store`, `max_completion_tokens` and `tools`, and `reasoning` for the 309 models that reason. The system prompt is the first message, and an assistant message carries the model's reasoning back in a `reasoning` field.
- **Tools:** the seven of [How pi is run](agent.md#how-pi-is-run), and no other.
- **Images** go inline: a `base64` source inside the tool result on the messages route, and a `data:` URL in a user message after the tool result on the chat route.
- Without `--thinking`, pi asks for its own default level, `medium`.

`test/tools/fixtures.test.mjs` fails, with no VM needed, when pi's version in the build file changes and the fixtures aren't captured again.

## Facts about OpenRouter

- **It can fetch from the web on a request's behalf:** the server tools `openrouter:web_search` and `openrouter:web_fetch`, which fetches any URL the model picks, the `web` plugin, the `:online` model suffix, and images given by URL. The settings on an account's Plugins tab don't apply to server tools, and its guardrails can limit a key's models and spending but not these tools, so only the policy can stop them.
- **Its answers:** a request with a dummy key gets 401, and a well-formed but unknown key gets 401 "User not found.", in 70 to 440 ms, decided before it reads the body. pi's first request was about 15.8 KB on the connection, and 24 KB with the agent's instructions; the answer 1.2 KB.
- **Zero data retention**, from its documents on 2026-11-15:
  - ZDR means no routine storage of prompts or responses after processing. From 27 October 2026, OpenRouter screens every request, ZDR included, for child sexual abuse material, and may keep what it flags.
  - It can be enforced in the account's privacy settings, in a guardrail on a key, or per request with `provider: {"zdr": true}`. These combine with OR, so a request can add ZDR but never remove it. Settings and guardrails apply it per model group: Anthropic, OpenAI, Google, SpaceXAI and all other models.
  - Endpoints with "Safety Retention" may keep prompts to detect abuse. ZDR-enforced requests can still use them unless the account or the guardrail is set to "ZDR only"; self-serve accounts allow them by default.
  - For Anthropic's models, ZDR removes Anthropic's own endpoints and leaves Amazon Bedrock and Google Vertex. On 2026-11-15, `anthropic/claude-sonnet-5.5` had six ZDR endpoints (Bedrock: `us-east-1`, `eu-west-1` and global; Vertex: global, `us` and `europe`), none with Safety Retention, in the public list at `GET /api/v1/endpoints/zdr`.
  - In-memory prompt caching doesn't count as retention, so it's allowed under ZDR.
  - ZDR covers model inference only, not plugins or server tools such as web search, which the policy refuses anyway.
  - The messages route's reference shows a `provider` object, but only with `allow_fallbacks`.

## Facts about Gondolin's network

Gondolin 0.14.0, by checks in a VM and by its source:
- The guest's DNS is answered by the host with made-up addresses, by default. UDP other than DNS, raw TCP and tunnels are refused, and so are loopback, cloud-metadata, LAN, VPN and container addresses, including through DNS tricks and redirects; HTTPS from the VM to a private address given as a number, such as `10.0.0.1` or `169.254.169.254`, is refused before the hook sees anything of it.
- HTTPS is intercepted with a certificate authority the guest trusts. Only HTTP/1.1 is supported. Gondolin makes the upstream requests itself and ignores proxy settings.
- A secret is tied to hosts: the guest sees a placeholder, which the host replaces, after the hook, anywhere in any header of a request to those hosts only.
- An `onRequest` hook sees the method, URL, headers and body, and can refuse the request, rewrite it, or answer it itself; an answer it gives is read whole before the VM gets it. With a hook, every HTTP(S) request reaches it before any lookup or check of an address, also one to a host outside `allowedHosts`, so the hook must refuse other hosts itself. Gondolin follows a redirect itself, handing each hop to the hook again with the headers of the hop before, the key among them. It refuses a body longer than `maxHttpBodyBytes` before the hook.
- In 0.14.0 an `onResponse` hook makes Gondolin buffer the whole response before the guest gets any of it, which breaks streaming; logging from undici's diagnostics events works instead. undici publishes `undici:request:create` in the request's constructor, with its headers as a list of names and values, which it writes when the request has a connection, so a header taken out there stays off the wire. A connection refused gives `undici:request:error` with `ECONNREFUSED`; a body cancelled after the status gives it with an `AbortError`, whose code is a number. `fetch` refuses a port on the Fetch standard's list of bad ones, such as 1 or 9, before it makes a request.
- With every request refused, pi 1.5.2 exits with 1 after about a second, and makes no further try.
