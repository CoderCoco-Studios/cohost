---
title: MCP tool servers
description: Add an MCP server so the co-host can use its tools, approve each tool, and know what leaves your machine when it calls one.
track: simple
---

# MCP tool servers

The co-host also has four built-in tools (clock, stream info, memory lookup and timers) that need no server; see [Built-in tools](built-in-tools.md). By the end of this page you will know how to add an [MCP](../../start/glossary.md#mcp) server to the co-host, which of its tools the co-host may use, and what each call sends and returns. An MCP server is a web service you run or trust that offers tools, such as a web search. The co-host calls its tools in the middle of a reply when the model asks for one.

## What you need

- A [real install](../install/real-install.md) with the dashboard running.
- The server's address (an `http` or `https` URL that ends at the MCP endpoint) and, if it needs one, its token.
- Read the warning below before you add a server.

**Each call sends text to that server.** The arguments of a call are text the model wrote from the conversation, so a server receives part of what is said on stream or in chat. The token, if you set one, is sent with every request to that server. Only add servers you run or trust.

## Add a server

1. Open **Settings**, **Tools**, and add a server under **MCP servers**. Give it a name made of lower-case letters, digits and hyphens, starting with a letter. A name cannot contain an underscore.
2. Enter its URL. Use `https` whenever the server offers it. A URL with a user name or password in it is refused; put a credential in the token field instead.
3. If the server needs a token, enter it in the server's **Token** field. It is kept in `config/secrets.yaml` under `tools.servers.<name>.token`, is never shown again once saved, and is sent only to that server's URL.
4. If the server takes its token in a header other than `Authorization`, set the header name. A blank header means `Authorization`, which is sent as `Bearer <token>`. Any other header receives the token as written.
5. Save, and restart the `tools` service. In the dashboard, open the Services screen and restart `tools`, or from a terminal in the cohost folder run `docker compose restart tools`.

The co-host connects to every server you add when the service starts, and lists its tools. It re-lists them when the server announces a change and every `tools.catalog_ms` (30 seconds by default), so a tool the server adds or removes appears on its own. A server that cannot be reached is shown as down; the co-host keeps working without it and reconnects in the background.

## Choose which tools it may use

A server's tools are listed but not used until you approve each one. In the dashboard, each tool shows its name, its description as the server gives it, its arguments, and its label:

- **read** means the server says the tool only reads. **acts** means the server says it changes something. **unlabelled** means the server did not say.
- Turn a tool on with its **enabled** mark. An acting tool, and any tool the server did not label read-only, also needs its **acts** mark before the co-host may call it. The co-host then asks you to confirm each acting call before it runs.
- Approving a tool records a fingerprint of its name, title, description, arguments and label. If the server later changes any of them, the tool is not offered until you approve it again. The co-host shows you the change first.

The description is the server's own text. Read it before you approve a tool.

## Off-LAN servers are flagged

A server is **external** when its host is not on your local network by the co-host's LAN rule, or when you mark it external yourself. Mark a server external even when its host is on your LAN if that server forwards requests to the internet, such as a web-search proxy; the co-host cannot see what a LAN server does with a request.

An external server is flagged in three places: the tools section of the dashboard, the start-up log, where the `tools` service writes one warning for each off-LAN server naming the server and its host, and the heartbeat detail, which reads `off LAN:` followed by the names. A plain `http` server outside the LAN that has a token is also noted as sending a credential without TLS. The co-host still connects to it, because you decide what leaves your network.

## What leaves your machine, and what comes back

For each call the co-host sends the server the tool's name and the arguments the model wrote, plus, for each request, the token in its header. The server's host sees the request, and anything the server does with it is outside cohost's control.

A server's answer is untrusted. The co-host gives the model the text of the result, cut to `tools.max_result_chars` (1500 characters by default), and marks the result as coming from a tool. Text in a result cannot change the co-host's rules, cannot make it call another tool and cannot make it act without the confirmation you set. A result longer than 1 MiB is not used: the call fails with the sentence "The server's response was too large and was not used." A resource link in a result is never fetched. The co-host sends no request anywhere except the URL you configured.

## How you know it worked

- The dashboard lists the server as connected and shows its tools with their labels.
- After you enable a tool, a reply that needs it calls it. The dashboard's live feed shows the call and its result. Refusals name the reason, such as "not approved yet" or "the server for that tool is not connected".
- The `tools` service reports `mcp.<name>` as `ok` in its [health](../../start/glossary.md#heartbeat) for each server that has an enabled tool.

## If it didn't

- **The server shows as refused its credential.** The server answered 401 or 403. Check the token, and the header name if the server takes its token elsewhere. The co-host reads the token once, when the `tools` service starts. After you change it, restart `tools`.
- **The server shows as not connected.** The address is wrong, the server is down, or it did not answer within 10 seconds when connecting. Open the URL from the machine running cohost to check.
- **A tool is listed but not offered.** It is not enabled, it acts without the acts mark, it is not approved yet, or its definition changed after you approved it.
- **A tool's answer is an error.** The server reported an error for that call. The co-host shows the error and keeps the server connected.
- **The server's detail says the credential cannot be sent.** The token has a character a header cannot carry: a control character, or a character above U+00FF, such as a curly quote pasted from a web page. The co-host does not send it and does not show it. Retype the token with plain characters, save it, and restart `tools`.
- **A tool is missing from the list.** The server's detail counts the tools it left out: a name that is not letters, digits, hyphens or underscores, a name longer than 64 characters, an argument schema over 4000 characters or nested more than 64 levels deep, or tools beyond the limit of 32 per server. The count is in the detail, and the other tools are not affected.

This client has been tested against its own test servers only. Run a new server once with a harmless tool, and read its result in the feed, before you trust it with more.

For anything else, see the [troubleshooting page](../troubleshooting.md).
