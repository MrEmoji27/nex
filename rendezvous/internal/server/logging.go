package server

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"nex.rendezvous/internal/apierr"
)

// Contract §9 fixes exactly what a log line may contain:
//
//	timestamp, method, path (without query), status code, duration bucket, error code
//
// and exactly what it may never contain: request bodies, handles paired with
// IPs, search terms, introduction graphs, node IDs, User-Agent. The access
// logger below has no field for any of those, which is the only durable way to
// keep them out — a redaction step can be forgotten, an absent field cannot.

// SanitizePath strips the query string from a request target.
//
// This is the §9 rule that "the handle query parameter must be stripped before
// any log line is written". It is done by cutting everything from the first '?',
// rather than by removing the handle key specifically: a stripper that knows one
// parameter name will leak the next parameter someone adds.
func SanitizePath(target string) string {
	if i := strings.IndexByte(target, '?'); i >= 0 {
		target = target[:i]
	}
	if i := strings.IndexByte(target, '#'); i >= 0 {
		target = target[:i]
	}
	return target
}

// DurationBucket coarsens a request duration. An exact duration on the search
// path is a timing side channel; a bucket is enough to see that the service is
// slow without telling anyone whether a particular handle exists.
func DurationBucket(d time.Duration) string {
	switch {
	case d < time.Millisecond:
		return "<1ms"
	case d < 10*time.Millisecond:
		return "<10ms"
	case d < 100*time.Millisecond:
		return "<100ms"
	case d < time.Second:
		return "<1s"
	default:
		return ">=1s"
	}
}

// Logger writes access lines. It is deliberately a narrow interface: there is no
// way to hand it a request object it could over-report from.
type Logger interface {
	Access(method, path string, status int, bucket string, errCode apierr.Code)
}

// slogLogger is the production logger.
type slogLogger struct{ l *slog.Logger }

// NewLogger builds a logger writing structured lines to w.
func NewLogger(w io.Writer) Logger {
	return slogLogger{l: slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo}))}
}

func (s slogLogger) Access(method, path string, status int, bucket string, errCode apierr.Code) {
	attrs := []any{
		slog.String("method", method),
		slog.String("path", path),
		slog.Int("status", status),
		slog.String("duration", bucket),
	}
	if errCode != "" {
		attrs = append(attrs, slog.String("error", string(errCode)))
	}
	s.l.Info("access", attrs...)
}

// discardLogger drops everything. Used by tests that assert on behaviour rather
// than on output.
type discardLogger struct{}

func (discardLogger) Access(string, string, int, string, apierr.Code) {}

// NewDiscardLogger returns a logger that writes nothing.
func NewDiscardLogger() Logger { return discardLogger{} }

// recorder captures the status and error code a handler produced so the access
// logger can report them without the handler having to.
type recorder struct {
	http.ResponseWriter
	status  int
	errCode apierr.Code
	written bool
}

func (r *recorder) WriteHeader(code int) {
	if r.written {
		return
	}
	r.status = code
	r.written = true
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	if !r.written {
		r.status = http.StatusOK
		r.written = true
	}
	return r.ResponseWriter.Write(b)
}

// Unwrap lets the WebSocket upgrade reach the underlying ResponseWriter, which
// must support http.Hijacker.
func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
