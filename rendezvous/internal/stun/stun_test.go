// Package stun implements a minimal RFC 5389 STUN binding responder.
package stun

import (
	"encoding/binary"
	"net"
	"testing"
)

func TestHandlePacket(t *testing.T) {
	// Build a valid binding request
	req := buildBindingRequest([12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12})

	// Source address to respond to
	remoteAddr := &net.UDPAddr{
		IP:   net.ParseIP("192.0.2.1").To4(),
		Port: 54321,
	}

	resp := handlePacket(req, remoteAddr)
	if resp == nil {
		t.Fatal("expected response for valid binding request, got nil")
	}

	// Verify response is a binding success
	if len(resp) < headerSize {
		t.Fatalf("response too short: %d bytes", len(resp))
	}
	msgType := binary.BigEndian.Uint16(resp[0:2])
	if msgType != msgTypeBindingResponse {
		t.Fatalf("expected binding response (0x0101), got 0x%04x", msgType)
	}

	// Verify magic cookie
	cookie := binary.BigEndian.Uint32(resp[4:8])
	if cookie != magicCookie {
		t.Fatalf("expected magic cookie 0x%08x, got 0x%08x", magicCookie, cookie)
	}

	// Verify transaction ID matches
	txID := resp[8:20]
	expectedTxID := [12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	for i := 0; i < 12; i++ {
		if txID[i] != expectedTxID[i] {
			t.Fatalf("txID mismatch at byte %d: expected %d, got %d", i, expectedTxID[i], txID[i])
		}
	}

	// Parse XOR-MAPPED-ADDRESS attribute
	attrOffset := headerSize
	attrType := binary.BigEndian.Uint16(resp[attrOffset : attrOffset+2])
	if attrType != attrXORMappedAddress {
		t.Fatalf("expected XOR-MAPPED-ADDRESS attribute (0x0020), got 0x%04x", attrType)
	}
	attrLen := binary.BigEndian.Uint16(resp[attrOffset+2 : attrOffset+4])
	if attrLen != 8 {
		t.Fatalf("expected attribute length 8, got %d", attrLen)
	}

	// Decode and verify the address round-trips
	ip, port, err := DecodeXORMappedAddress(resp[attrOffset+4 : attrOffset+4+8])
	if err != nil {
		t.Fatalf("failed to decode XOR-MAPPED-ADDRESS: %v", err)
	}
	if !ip.Equal(remoteAddr.IP) {
		t.Fatalf("IP mismatch: expected %v, got %v", remoteAddr.IP, ip)
	}
	if port != remoteAddr.Port {
		t.Fatalf("port mismatch: expected %d, got %d", remoteAddr.Port, port)
	}
}

func TestXORAddressRoundTrip(t *testing.T) {
	testCases := []struct {
		name string
		ip   net.IP
		port int
	}{
		{"typical", net.ParseIP("192.0.2.1").To4(), 54321},
		{"google-dns", net.ParseIP("8.8.8.8").To4(), 12345},
		{"cloudflare", net.ParseIP("1.1.1.1").To4(), 65535},
		{"port-80", net.ParseIP("203.0.113.1").To4(), 80},
		{"port-1", net.ParseIP("198.51.100.1").To4(), 1},
		{"port-3478", net.ParseIP("192.0.2.100").To4(), 3478},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Encode
			attr := encodeXORMappedAddress(tc.ip, tc.port)
			if len(attr) != 8 {
				t.Fatalf("expected attribute value length 8, got %d", len(attr))
			}

			// Decode
			ip, port, err := DecodeXORMappedAddress(attr)
			if err != nil {
				t.Fatalf("decode failed: %v", err)
			}
			if !ip.Equal(tc.ip) {
				t.Fatalf("IP round-trip failed: expected %v, got %v", tc.ip, ip)
			}
			if port != tc.port {
				t.Fatalf("port round-trip failed: expected %d, got %d", tc.port, port)
			}
		})
	}
}

func TestWrongMagicCookieIgnored(t *testing.T) {
	// Build request with wrong magic cookie
	req := make([]byte, headerSize)
	binary.BigEndian.PutUint16(req[0:2], msgTypeBindingRequest)
	binary.BigEndian.PutUint16(req[2:4], 0)
	binary.BigEndian.PutUint32(req[4:8], 0xDEADBEEF) // Wrong cookie
	txID := [12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	copy(req[8:20], txID[:])

	remoteAddr := &net.UDPAddr{
		IP:   net.ParseIP("192.0.2.1").To4(),
		Port: 54321,
	}

	resp := handlePacket(req, remoteAddr)
	if resp != nil {
		t.Fatal("expected nil response for wrong magic cookie, got response")
	}
}

func TestTruncatedPacketIgnored(t *testing.T) {
	// Packet shorter than header
	short := make([]byte, 10)
	remoteAddr := &net.UDPAddr{
		IP:   net.ParseIP("192.0.2.1").To4(),
		Port: 54321,
	}

	resp := handlePacket(short, remoteAddr)
	if resp != nil {
		t.Fatal("expected nil response for truncated packet, got response")
	}
}

func TestWrongMessageTypeIgnored(t *testing.T) {
	// Valid cookie but wrong message type (e.g., indication)
	req := make([]byte, headerSize)
	binary.BigEndian.PutUint16(req[0:2], 0x0003) // Not a binding request
	binary.BigEndian.PutUint16(req[2:4], 0)
	binary.BigEndian.PutUint32(req[4:8], magicCookie)
	txID := [12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	copy(req[8:20], txID[:])

	remoteAddr := &net.UDPAddr{
		IP:   net.ParseIP("192.0.2.1").To4(),
		Port: 54321,
	}

	resp := handlePacket(req, remoteAddr)
	if resp != nil {
		t.Fatal("expected nil response for wrong message type, got response")
	}
}

func TestIPv6Ignored(t *testing.T) {
	req := buildBindingRequest([12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12})
	remoteAddr := &net.UDPAddr{
		IP:   net.ParseIP("2001:db8::1"),
		Port: 54321,
	}

	resp := handlePacket(req, remoteAddr)
	if resp != nil {
		t.Fatal("expected nil response for IPv6, got response")
	}
}

func TestMismatchedLengthIgnored(t *testing.T) {
	// Header says length 100 but packet is only 20 bytes
	req := make([]byte, headerSize)
	binary.BigEndian.PutUint16(req[0:2], msgTypeBindingRequest)
	binary.BigEndian.PutUint16(req[2:4], 100) // Wrong length
	binary.BigEndian.PutUint32(req[4:8], magicCookie)
	txID := [12]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	copy(req[8:20], txID[:])

	remoteAddr := &net.UDPAddr{
		IP:   net.ParseIP("192.0.2.1").To4(),
		Port: 54321,
	}

	resp := handlePacket(req, remoteAddr)
	if resp != nil {
		t.Fatal("expected nil response for mismatched length, got response")
	}
}

// Helper functions for tests

func buildBindingRequest(txID [12]byte) []byte {
	req := make([]byte, headerSize)
	binary.BigEndian.PutUint16(req[0:2], msgTypeBindingRequest)
	binary.BigEndian.PutUint16(req[2:4], 0) // No attributes
	binary.BigEndian.PutUint32(req[4:8], magicCookie)
	copy(req[8:20], txID[:])
	return req
}

func encodeXORMappedAddress(ip net.IP, port int) []byte {
	attr := make([]byte, 8)
	attr[0] = 0 // reserved
	attr[1] = 1 // IPv4 family
	// XOR port
	xPort := uint16(port) ^ uint16(magicCookie>>16)
	binary.BigEndian.PutUint16(attr[2:4], xPort)
	// XOR address bytes
	cookieBytes := [4]byte{
		byte(magicCookie >> 24),
		byte((magicCookie >> 16) & 0xFF),
		byte((magicCookie >> 8) & 0xFF),
		byte(magicCookie & 0xFF),
	}
	for i := 0; i < 4; i++ {
		attr[4+i] = ip[i] ^ cookieBytes[i]
	}
	return attr
}

// TestMessageLengthCountsAttributeHeaders pins the field that broke interop.
//
// The response carried 8 — the XOR-MAPPED-ADDRESS value length — where RFC 5389
// requires the total size of all attributes including their 4-byte headers, so
// 12. This implementation parsed its own output anyway, because it reads
// attributes until the buffer ends rather than trusting the length. A
// conforming client trusts it, stops four bytes early, and sees a truncated
// address.
//
// Every test here passed while that was wrong. It was found by pointing a
// different implementation at it, which is the only thing that could have.
func TestMessageLengthCountsAttributeHeaders(t *testing.T) {
	req := make([]byte, headerSize)
	binary.BigEndian.PutUint16(req[0:2], msgTypeBindingRequest)
	binary.BigEndian.PutUint16(req[2:4], 0)
	binary.BigEndian.PutUint32(req[4:8], magicCookie)
	copy(req[8:20], []byte("0123456789ab"))

	resp := handlePacket(req, &net.UDPAddr{IP: net.IPv4(203, 0, 113, 7), Port: 40000})
	if resp == nil {
		t.Fatal("no response to a valid binding request")
	}

	declared := int(binary.BigEndian.Uint16(resp[2:4]))
	if declared != len(resp)-headerSize {
		t.Fatalf("message length = %d, but %d bytes of attributes follow the header",
			declared, len(resp)-headerSize)
	}
	if declared != 12 {
		t.Fatalf("message length = %d, want 12 (4-byte attribute header + 8-byte value)", declared)
	}
}
