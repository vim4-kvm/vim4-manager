package board

import (
	"github.com/vim4-kvm/vim4-manager/internal/i18n"
	"testing"
)

func TestStatusLabelsArePerRequest(t *testing.T) {
	baseline := Status{Apps: []AppState{{App: Apps[0]}}, Platform: []Platform{{Name: PlatformUnits[0].Name, Unit: Unit{Name: PlatformUnits[0].Unit}}}}
	english, chinese := baseline, baseline
	chinese.LocalizeLabels(i18n.Chinese)
	english.LocalizeLabels(i18n.English)
	if chinese.Platform[0].Name != "HDMI 采集" || english.Platform[0].Name != "HDMI capture" {
		t.Fatal("service labels did not follow locale")
	}
	if chinese.Apps[0].Description == english.Apps[0].Description {
		t.Fatal("app descriptions did not follow locale")
	}
	if baseline.Platform[0].Name != PlatformUnits[0].Name || baseline.Apps[0].Description != Apps[0].Description {
		t.Fatal("localized response mutated shared definitions")
	}
}
