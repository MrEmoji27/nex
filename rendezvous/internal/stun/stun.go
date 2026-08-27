// Package stun implements a minimal RFC 5389 STUN binding responder.
//
// It answers binding requests with an XOR-MAPPED-ADDRESS attribute so a
// client can learn its public address without depending on third-party STUN
// servers. The responder is intentionally minimal: it only handles valid
// binding requests, ignores malformed packets, and never sends unsolicited
// responses (which would be an amplification vector).
package stun

import (
	"context"
	"encoding/binary"
	"net"
	"time"
)

// RFC 5389 constants
const (
	// Message types
	msgTypeBindingRequest  = 0x0001
	msgTypeBindingResponse = 0x0101
	msgTypeBindingError    = 0x0111

	// Magic cookie per RFC 5389
	magicCookie = 0x2112A442

	// Attributes
	attrXORMappedAddress = 0x0020

	// Header size
	headerSize = 20
)

// Server is a minimal STUN binding responder.
type Server struct {
	conn *net.UDPConn
}

// NewServer creates a new STUN server listening on the given address.
// If addr is empty, ":3478" is used.
func NewServer(addr string) (*Server, error) {
	if addr == "" {
		addr = ":3478"
	}
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return nil, err
	}
	return &Server{conn: conn}, nil
}

// Serve reads and responds to STUN packets until the context is cancelled.
// Errors from reading are logged internally; the function returns when ctx is done.
func (s *Server) Serve(ctx context.Context) error {
	buf := make([]byte, 1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		// Set a read deadline so we can check ctx periodically
		s.conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		n, remoteAddr, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue
		}
		if response := handlePacket(buf[:n], remoteAddr); response != nil {
			// Ignore write errors; the client may have disappeared
			_, _ = s.conn.WriteToUDP(response, remoteAddr)
		}
	}
}

// Close closes the underlying UDP connection.
// Addr reports the address actually bound, which matters when the configured
// port was 0 and the OS chose one.
func (s *Server) Addr() string {
	if s.conn == nil {
		return ""
	}
	return s.conn.LocalAddr().String()
}

func (s *Server) Close() error {
	return s.conn.Close()
}

// handlePacket processes a single UDP packet. Returns a response packet if
// the input is a valid binding request, otherwise nil.
func handlePacket(pkt []byte, remoteAddr *net.UDPAddr) []byte {
	// Minimum valid packet is a 20-byte header
	if len(pkt) < headerSize {
		return nil
	}

	// Parse header
	msgType := binary.BigEndian.Uint16(pkt[0:2])
	msgLen := binary.BigEndian.Uint16(pkt[2:4])
	cookie := binary.BigEndian.Uint32(pkt[4:8])
	txID := pkt[8:20]

	// Must be a binding request with correct magic cookie
	if msgType != msgTypeBindingRequest || cookie != magicCookie {
		return nil
	}

	// Validate message length matches actual packet
	if len(pkt) != headerSize+int(msgLen) {
		return nil
	}

	// Extract source address from remoteAddr (IPv4 only)
	ip := remoteAddr.IP.To4()
	if ip == nil {
		return nil // IPv6 not supported
	}
	port := remoteAddr.Port

	// Build binding success response
	// Header: type(2) + length(2) + cookie(4) + txID(12) = 20 bytes
	// Attribute: type(2) + length(2) + value(8 for IPv4) = 12 bytes, padded to 4-byte boundary
	resp := make([]byte, headerSize+12)
	respView := resp

	// Message header
	binary.BigEndian.PutUint16(respView[0:2], msgTypeBindingResponse)
	// Message length counts whole attributes, header included: 4 + 8 = 12.
	// Writing 8 here — the value length alone — produces a packet that this
	// implementation still parses, because it reads attributes until the buffer
	// ends rather than trusting the field. A conforming client does trust it,
	// stops 4 bytes early, and finds the address truncated. Caught by testing
	// against a foreign implementation; our own tests agreed with our own bug.
	binary.BigEndian.PutUint16(respView[2:4], 12)
	binary.BigEndian.PutUint32(respView[4:8], magicCookie)
	copy(respView[8:20], txID)

	// XOR-MAPPED-ADDRESS attribute
	attrOffset := headerSize
	binary.BigEndian.PutUint16(respView[attrOffset:attrOffset+2], attrXORMappedAddress)
	binary.BigEndian.PutUint16(respView[attrOffset+2:attrOffset+4], 8)
	// Value: reserved(1) + family(1) + xport(2) + xaddr(4)
	respView[attrOffset+4] = 0 // reserved
	respView[attrOffset+5] = 1 // IPv4 family

	// XOR port with top 16 bits of magic cookie
	xPort := uint16(port) ^ uint16(magicCookie>>16)
	binary.BigEndian.PutUint16(respView[attrOffset+6:attrOffset+8], xPort)

	// XOR each address byte with matching byte of magic cookie
	cookieBytes := [4]byte{
		byte(magicCookie >> 24),
		byte((magicCookie >> 16) & 0xFF),
		byte((magicCookie >> 8) & 0xFF),
		byte(magicCookie & 0xFF),
	}
	for i := 0; i < 4; i++ {
		respView[attrOffset+8+i] = ip[i] ^ cookieBytes[i]
	}

	return resp
}

// DecodeXORMappedAddress decodes an XOR-MAPPED-ADDRESS attribute from a
// STUN response. Returns the IP and port, or an error if decoding fails.
// This is exported for testing.
func DecodeXORMappedAddress(attr []byte) (net.IP, int, error) {
	if len(attr) < 8 {
		return nil, 0, ErrInvalidAttribute
	}
	family := attr[1]
	if family != 1 {
		return nil, 0, ErrUnsupportedFamily
	}
	xPort := binary.BigEndian.Uint16(attr[2:4])
	port := int(xPort ^ uint16(magicCookie>>16))

	cookieBytes := [4]byte{
		byte(magicCookie >> 24),
		byte((magicCookie >> 16) & 0xFF),
		byte((magicCookie >> 8) & 0xFF),
		byte(magicCookie & 0xFF),
	}
	ip := make(net.IP, 4)
	for i := 0; i < 4; i++ {
		ip[i] = attr[4+i] ^ cookieBytes[i]
	}
	return ip, port, nil
}

// Errors
var (
	ErrInvalidAttribute  = &stunError{"invalid attribute length"}
	ErrUnsupportedFamily = &stunError{"unsupported address family"}
)

type stunError struct{ msg string }

func (e *stunError) Error() string { return "stun: " + e.msg }
