# How Nex was built, and what it is for

## The idea

Every messaging app you use is a triangle. You talk to a server, the server
talks to your friend. The server is the point of the product: it holds accounts,
routes messages, and — necessarily — sees who talks to whom.

Nex removes the third corner. Two terminals connect directly, over a link
neither party can read from the outside, and there is no third machine involved
in the conversation. Not one that promises not to look. One that is not there.

That is the whole thesis, and everything else in the codebase is a consequence
of it:

- **Identity is a key on your machine**, not a row in someone's database. Nobody
  issues it, nobody can revoke it, and nobody can lock you out of it.
- **Nobody can read your messages**, because nobody is carrying them.
- **Nothing to shut down.** If every piece of infrastructure in this project
  vanished tonight, two people who already know each other could still talk.

## What that costs

Honesty about the trade-offs is the point of this document.

**Two people who have never met cannot find each other.** A server-based app
solves discovery trivially, because everyone is already connected to the same
server. Nex has to solve it some other way, or not at all.

**There is no message history in the cloud.** Lose your machine, lose your
conversations. That is a feature to some people and a dealbreaker to others.

**Being reachable is your problem.** A server has a stable public address. Your
laptop does not. This is the hardest unsolved part of the project.

## The three ways two people find each other

Discovery is where most of the design effort went, because it is where the
architecture makes life hardest.

**Same network.** Two machines on one Wi-Fi announce themselves and hear each
other. No internet, no configuration, no third party. This works today and is
the purest version of the idea.

**An invitation.** One person generates a `nex://` code and sends it however
they like — signal, paper, out loud. The code carries a fingerprint, so the
first connection is *checked* rather than trusted. This works today.

**The Rendezvous service.** For people not on the same network who have not
swapped a code. This is the compromise, and it is deliberately shaped to give
away as little as possible.

## Rendezvous: a compromise with a leash on it

The service answers one question — "is there someone here called `roshan`?" —
and passes along one introduction. Then it is finished.

Constraints designed in from the start, not added later:

- **It is off by default.** Nothing contacts it unless you turn it on.
- **It cannot carry your messages.** Not by policy — by construction. There is
  no message type in its protocol with room for content in it. Nothing to
  misconfigure, nothing to leak.
- **A search tells you someone exists. It does not tell you where they are.**
  Address information is only released after the other person accepts.
- **Asking costs you first.** To request an introduction is to hand over your
  own address before receiving theirs.
- **It knows nothing after you hang up.** Presence is a short lease held in
  memory. There is no database. Restart the service and everyone vanishes from
  it, then reappears as their apps check back in.
- **It cannot prove who anyone is, and does not claim to.** It checks that a
  record was signed by the key sitting next to it. Whether that key belongs to
  the person it claims to is settled directly between the two apps afterwards.

## How it was built

Written by one person with AI assistance, in short intense stretches, with a
frozen written protocol between the halves so two implementations could be
built in parallel without drifting.

Three decisions shaped everything:

**Write the protocol down first, then implement it twice.** The wire contract
was specified before either side existed. A Go service and a TypeScript client
were written against it independently. Both are checked against shared frozen
vectors that neither of them owns — so if they ever disagree, a test fails
instead of a user hitting an interoperability bug nobody can reproduce.

**Prefer being refused to being clever.** Several designs were changed because
the system said no. The Windows audio layer rejected a stream configuration, so
the code took the device's terms instead of insisting on its own. A codec
library would not build on this platform, so the feature was rewritten in a way
that works everywhere rather than shipped for one operating system.

**Treat a passing test suite as weak evidence.** This is the most important
lesson in the project, and it was learned the hard way.

## The bug worth telling you about

A review found code labelled `Noise_XX` — a well-known, published encryption
handshake — that did not actually implement `Noise_XX`. Three separate
deviations from the specification.

Every one of them was symmetric. Both halves of the system made the identical
mistake, so they agreed with each other perfectly. Every test passed. Two Nex
nodes could talk. The result was not the protocol it advertised and would not
have interoperated with any other implementation of it.

It was found by testing against the **standard's own published test vectors** —
outside evidence — rather than against our own output.

The rule that came out of it governs everything since: *passing your own tests
proves your code is self-consistent, not that it is correct.* Both sides can be
wrong in the same way. Where a claim in this project matters, it is checked
against something external, and where that could not be done, the gap is
written down instead of glossed over.

## Where it actually is

Alpha. Genuinely.

**Works:** direct encrypted chat, persistent identity with first-contact
verification, encrypted local storage, group rooms, discovery all three ways,
and voice — real microphone capture, Opus, echo cancellation.

**Does not work yet:** connecting two people who are both behind home routers,
without one of them forwarding a port. There is no NAT traversal. This is the
biggest gap between what Nex is and what it needs to be, and it is the next
hard problem.

**Not audited.** The cryptography is standard and carefully applied, but nobody
outside this project has reviewed it. Do not bet anything that matters on it
yet.

## Why bother

Because the alternative to a server holding your conversation is not a better
server. It is no server.

That is a harder thing to build, and worse at some things — discovery is
awkward, and reachability is genuinely unsolved. But the properties it gets in
exchange cannot be added to a centralised system afterwards, however good its
privacy policy is. They come from the shape of the thing.
