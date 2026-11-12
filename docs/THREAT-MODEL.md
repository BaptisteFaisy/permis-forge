# Threat model — what an attacker controls, and what the fuzz proved

> Scope: the two HTTP surfaces of the app (the `gate` and the operator
> `admin` web trigger) and the decision they produce. The specification of
> record is [`SPEC.md`](SPEC.md); the hook setup is [`HOOK-SETUP.md`](HOOK-SETUP.md).

## 1. What an attacker controls

| Surface | Who can reach it | What they control |
|---|---|---|
| `gate`, decision mode | anyone with the gate URL **and** a personal token | the whole hook payload: `toolName`, `args`, the ticket header |
| `gate`, verification mode | anyone with the gate URL — **no token** | `permitId` and the `paths` submitted with it |
| `admin` | anyone with the installation secret | the operation and its arguments |

The identity of the caller is **never** taken from the payload: it comes from
the token hash (decision mode) or from the installation secret (operator). An
attacker who controls a payload cannot claim to be somebody else.

What an attacker cannot forge: a permit signature (HMAC-SHA256 over the signed
fields, keyed with the installation secret), a ledger entry (hash-chained, and a
rewrite breaks the chain that the nightly job verifies and the anchor publishes
outside the database), or an approval (the service refuses the pilot of a
request as its own approver).

## 2. What the fuzz checks

`node scripts/fuzz-gate.mjs --cases N --seed S` and `test/gate-fuzz.test.ts` run
the same generators (`scripts/fuzz-lib.ts`) against the real handler. Inputs:
wrong types, missing and extra fields, 100 KB strings, NUL bytes, deeply nested
objects, prototype-pollution keys, malformed JSON, absurd permit ids — and
**dangerous payloads wrapped in that noise**, which is the interesting half.

Invariants, checked on every case:

1. the handler never throws;
2. the status is one the wire format allows (200 / 400 / 401 / 429 / 500);
3. a 200 carries either a hook decision or a permit verification;
4. a dangerous payload is **never** answered `allow`;
5. nothing pollutes `Object.prototype`.

Runs recorded: 300 cases (seed 20261112) and 120 cases (seed 20261119) in the
suite; 800 (seed 7) and 2000 (seed 99) from the command line. No violation.

## 3. The fail-open the fuzz found — and the fix

The first run of the fuzzer produced **34 violations of invariant 4**. Every one
had the same shape:

```json
{ "toolName": true, "args": { "command": "chmod 777 /etc/passwd" } }
```

A `toolName` that is not a string was coerced to `'unknown'`, so the payload
matched no known tool and fell into the generic branch, which put the arguments
in a free-form `description` and the tool name in the target. Deterministic
patterns read the target and the command — not the description — so nothing
matched, and the fallback class was **A-02 (edit application code, N5)**. The
gate answered `allow` for `rm -rf /var/lib/prod`, `DROP TABLE users`,
a forced push (`git push -f`) and `chmod 777 /etc/passwd`.

Who could have hit it: a command bridge with a mapping bug (the Cursor bridge
builds the payload itself), a client version that renames a tool, or anything
else that sends a malformed payload. It did not need a malicious actor — a
**buggy** client was enough to turn the hook into a rubber stamp, silently,
while the ledger kept recording "allow".

The fix is in `src/core/gate.ts`: for an unknown or malformed tool name the
arguments still decide what the action is, exactly as they do for a known tool.
The command and the path are lifted out of `args` into `target`/`command`, so
the deterministic patterns see them. The same cases now answer `deny`.

This is the reason the fuzzer exists: the property "closed by default" was
asserted in prose and in a dozen unit tests, and it was still false for an input
none of them contained.

## 4. Residual risks, stated

- **An unknown tool with no arguments** still falls back to A-02 (N5). There is
  nothing to classify: no target, no command. A client that strips `args` before
  calling the gate is not defended against by the app — only by the client's own
  hook configuration, which is class A-15 and cannot be widened by an agent.
- **A free-form description with no pattern match** is classified by the Forge
  `llm` module; if that call is unavailable the fallback is A-02. The doubt rule
  of §20 applies to the candidates the model returns, not to a total absence of
  signal.
- **The verification budget is per container**, not per client: nothing
  identifies an unauthenticated caller. It blunts bulk enumeration of sequential
  permit ids; it is not a hard ceiling.
- **The gate URL is a secret by possession.** Web triggers have no platform
  authentication, so anyone holding the URL can ask for verifications. It is
  stored in a CI secret and in `~/.atlassian/` at mode 600, and the answer is
  minimised so that holding the URL does not disclose what permits authorise.
- **A revoked token stops at the next call**, not at the current one: revocation
  is checked per request, so an in-flight decision completes.
