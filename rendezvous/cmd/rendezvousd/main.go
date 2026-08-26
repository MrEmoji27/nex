// Command rendezvousd runs the Nex Rendezvous service.
//
// The service is an optional discovery and introduction service. It never
// carries chat, room, voice or video payloads, never receives a Nex private key
// or seed, and is not an identity authority (V3 §4, wire contract §0). Once two
// peers have been introduced it is out of the communication path entirely.
//
// It holds no state on disk. Restarting it is a routine event: every lease
// lapses and every node re-registers on its next refresh tick.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"nex.rendezvous/internal/clock"
	"nex.rendezvous/internal/server"
)

func main() {
	cfg := server.ConfigFromEnv()

	srv := server.New(cfg, clock.Real{}, server.NewLogger(os.Stdout))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("rendezvous %s listening on %s", server.Version, cfg.Addr)
	if err := srv.ListenAndServe(ctx); err != nil {
		log.Fatalf("rendezvous: %v", err)
	}
}
