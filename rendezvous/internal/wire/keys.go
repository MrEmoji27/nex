package wire

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// ErrBadKey is returned when a presented signPub is not 64 lowercase hex chars.
var ErrBadKey = errors.New("wire: malformed signPub")

// DeriveSigningKey implements contract §1.3:
//
//	edSeed   = HMAC-SHA256(key = seedBytes, msg = UTF8("nex-rendezvous-sign-v1"))
//	signPriv = Ed25519 private key with seed edSeed
//
// The rendezvous signing key is derived, never stored separately and never
// transmitted. The service itself never calls this — it exists so tests (and any
// future Go-side tooling) reproduce the client derivation exactly.
func DeriveSigningKey(seed []byte) ed25519.PrivateKey {
	mac := hmac.New(sha256.New, seed)
	mac.Write([]byte(SignKeyDerivationLabel))
	return ed25519.NewKeyFromSeed(mac.Sum(nil))
}

// ParseSignPub decodes a signPub field: lowercase hex, exactly 64 chars.
func ParseSignPub(s string) (ed25519.PublicKey, error) {
	if len(s) != 64 || !IsLowerHex(s) {
		return nil, ErrBadKey
	}
	raw, err := hex.DecodeString(s)
	if err != nil {
		return nil, ErrBadKey
	}
	return ed25519.PublicKey(raw), nil
}

// Verify checks a lowercase-hex 128-char Ed25519 signature over msg.
//
// A true result proves only that the record was not forged or mutated in
// transit. It does NOT prove that signPub belongs to nodeId — see contract §6.
func Verify(signPub string, msg []byte, sigHex string) bool {
	pub, err := ParseSignPub(signPub)
	if err != nil {
		return false
	}
	if len(sigHex) != 128 || !IsLowerHex(sigHex) {
		return false
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return false
	}
	return ed25519.Verify(pub, msg, sig)
}

// Sign produces the lowercase-hex signature of msg. Test/tooling helper.
func Sign(priv ed25519.PrivateKey, msg []byte) string {
	return hex.EncodeToString(ed25519.Sign(priv, msg))
}

// IsLowerHex reports whether s is non-empty and consists only of [0-9a-f].
func IsLowerHex(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// IsUpperHex reports whether s is non-empty and consists only of [0-9A-F].
func IsUpperHex(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

// NodeIDLen is the length of a Nex nodeId: uppercase hex SHA-256 (src/core/identity.ts).
const NodeIDLen = 64

// IsNodeID reports whether s is a well-formed nodeId: 64 uppercase hex chars.
func IsNodeID(s string) bool { return len(s) == NodeIDLen && IsUpperHex(s) }

// IsNonce reports whether s is a well-formed nonce: 16 random bytes as 32
// lowercase hex chars (contract §4).
func IsNonce(s string) bool { return len(s) == 32 && IsLowerHex(s) }

// IsSig reports whether s is a well-formed signature field: 128 lowercase hex chars.
func IsSig(s string) bool { return len(s) == 128 && IsLowerHex(s) }

// IsNoisePub reports whether s is a well-formed X25519 static public key:
// 64 lowercase hex chars (contract §3.2).
func IsNoisePub(s string) bool { return len(s) == 64 && IsLowerHex(s) }
