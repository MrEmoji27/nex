package wire

// Domain separators. Every one of these is normative (contract §3, §5, §7);
// they must never be edited without an amendment to RENDEZVOUS_WIRE_V1.md.
const (
	DomainPublicDescriptor  = "nex-rendezvous/public-descriptor-v1"
	DomainContactDescriptor = "nex-rendezvous/contact-descriptor-v1"
	DomainRegister          = "nex-rendezvous/register-v1"
	DomainRefresh           = "nex-rendezvous/refresh-v1"
	DomainUnregister        = "nex-rendezvous/unregister-v1"
	DomainSearch            = "nex-rendezvous/search-v1"
	DomainIntroRequest      = "nex-rendezvous/introduction-request-v1"
	DomainIntroRespond      = "nex-rendezvous/introduction-respond-v1"
	DomainControl           = "nex-rendezvous/control-v1"
)

// SignKeyDerivationLabel is the HMAC message used to derive the rendezvous
// signing key from a Nex identity seed (contract §1.3). The service never sees
// a seed; this exists so tests and tooling derive keys the same way the client
// does.
const SignKeyDerivationLabel = "nex-rendezvous-sign-v1"
