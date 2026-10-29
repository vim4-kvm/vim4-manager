package board

import (
	"testing"

	"github.com/vim4-kvm/vim4-manager/internal/i18n"
)

func TestEventLocaleDoesNotChangeStoredMessage(t *testing.T) {
	events := &Events{Capacity: 2}
	events.AddMessage("good", i18n.Message{Key: "events.gatewayStarted"})
	en := events.List(i18n.English)
	zh := events.List(i18n.Chinese)
	if en[0].Text != "KVM gateway started" || zh[0].Text != "KVM 网关已启动" {
		t.Fatalf("en=%+v zh=%+v", en, zh)
	}
	if en[0].UnixMs != zh[0].UnixMs {
		t.Fatal("rendering changed event identity")
	}
	zh[0].Text = "changed by caller"
	if events.List(i18n.English)[0].Text != en[0].Text {
		t.Fatal("list mutated storage")
	}
}
