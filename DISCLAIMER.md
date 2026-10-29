# Disclaimer, intended use, and legal notice

Read this before you run OwnAI. It is the plain-language companion to the dual license in
[LICENSE](LICENSE) (MIT **or** GNU AGPL-3.0-or-later, your option), and it is part of how
this project is meant to be used.

## 1. Educational and research purpose

OwnAI is published as an educational project: a worked example of how a local gateway,
provider adapters, capability negotiation and browser automation fit together, and a
study of what "your own access" can and cannot honestly mean. It is not a product, not a
service, and not an offer of API access.

## 2. Provided as is, with no warranty

The software is provided "as is", without warranty of any kind, express or implied,
including merchantability, fitness for a particular purpose and non-infringement. The
authors are not liable for any claim, damage or other liability arising from the use of
the software. This restates the license; the license controls.

## 3. No affiliation or endorsement

OwnAI is not affiliated with, authorized by, sponsored by or endorsed by any AI provider
whose site or API it can connect to. Provider and product names appear only where the
software must name a host, a selector or a command argument, and all trademarks belong to
their owners. Nothing here grants you a provider's permission.

## 4. Your account, your risk

`permission: denied` plus `personal_use: true` on a consumer-web connection is a record
that **the provider has not authorized this use**. It is an acknowledgement by the
operator of this local instance that they are driving their own account on their own
machine — not a license, not consent from the provider, and not a defense.

Automated access to a consumer chat site may breach that provider's terms of service.
Accounts can be limited, suspended or terminated, and content generated through
automation might be treated differently from content you typed yourself. Some
jurisdictions and some plans have additional restrictions. If you are unsure, do not run
a browser connection; use an API key the provider issued for programmatic use instead.

## 5. What the software deliberately does not do

These are enforced in code, not only stated here:

- It never types a password or submits a sign-in form for you.
- It never solves, bypasses or "waits out" a CAPTCHA, human check, or account challenge;
  the check is handed back to you to complete in a visible window.
- It does not spoof fingerprints or user agents, rotate proxies, pool multiple accounts,
  or try to evade rate limits or enforcement.
- It binds to loopback only and refuses traffic from browsers and remote hosts.
- It is built for a single person's own use and is not a way to resell, share, or
  redistribute anyone's AI access. Serving other people is outside its design and
  outside this notice.

If you modify the software to do any of those things, the modification is yours. The
original project does not include it, endorsing it, or support it.

## 6. Data you are responsible for

The gateway stores content-free request metadata locally, keeps provider keys in your
OS credential store, and keeps each browser session in its own profile directory. You
are responsible for that local data, for rotating keys you believe are exposed
(`pnpm bridge rotate-key`), for deleting profiles you no longer need, and for complying
with the data-protection rules that apply where you live.

## 7. Licensing

You may use this code under **either** the MIT license **or** the GNU Affero General
Public License v3.0 or later, at your option; [LICENSE](LICENSE) links both full texts.
Under the AGPL branch, section 13 requires you to offer the corresponding source to anyone
who interacts with a modified version over a network. Under the MIT branch you may close,
sublicense and sell your build — and that choice changes nothing in sections 3 and 4
above: no license grants a provider's permission, and a provider's terms attach to the
account being signed into, not to your copy of this code. Third-party dependencies keep
their own licenses.

## 8. Not legal advice

This notice explains the project's intent and its technical guardrails. It is not legal
advice, and it cannot tell you whether a particular use is lawful where you are. Consult
a qualified lawyer before commercial or public use.

## 9. Reporting security issues

If you find a way the software could expose a key, a session, or a remote host, please
report it privately to the repository owner rather than opening a public issue with
exploit details. Do not test against accounts you do not own.
