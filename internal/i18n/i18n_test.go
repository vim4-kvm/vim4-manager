package i18n

import (
	"errors"
	"net/http/httptest"
	"reflect"
	"regexp"
	"sort"
	"testing"
)

func TestCatalogParity(t *testing.T) {
	params := func(text string) []string {
		values := regexp.MustCompile(`\{[a-zA-Z][a-zA-Z0-9]*\}`).FindAllString(text, -1)
		sort.Strings(values)
		return values
	}
	if len(en) != len(zhCN) {
		t.Fatalf("catalog sizes differ: %d / %d", len(en), len(zhCN))
	}
	for key, text := range en {
		translated, ok := zhCN[key]
		if !ok || translated == "" {
			t.Errorf("missing Chinese message: %s", key)
		}
		if !reflect.DeepEqual(params(text), params(translated)) {
			t.Errorf("parameters differ: %s", key)
		}
	}
}

func TestRequestLocale(t *testing.T) {
	for _, test := range []struct {
		cookie, accept string
		want           Locale
	}{
		{"", "", English}, {"en", "zh-CN", English}, {"zh-CN", "en", Chinese},
		{"invalid", "zh-TW", Chinese}, {"", "de, en;q=0.8", English},
		{"", "en;q=0.5, zh-CN;q=0.9", Chinese}, {"", "zh-CN;q=0, en", English},
		{"", "zh;q=invalid, en", English}, {"", "zh;q=NaN", English},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Cookie", "vim4_lang="+test.cookie)
		r.Header.Set("Accept-Language", test.accept)
		if got := RequestLocale(r); got != test.want {
			t.Errorf("%+v: got %s", test, got)
		}
	}
}

func TestWrappedError(t *testing.T) {
	cause := errors.New("disk offline")
	err := Wrap(cause, "auth.unavailable", nil)
	if !errors.Is(err, cause) {
		t.Fatal("cause lost")
	}
	if err.Error() != en["auth.unavailable"] {
		t.Fatal("logs must use English")
	}
	if RenderError(Chinese, err) != zhCN["auth.unavailable"] {
		t.Fatal("Chinese rendering failed")
	}
	message := Message{"missing", nil}
	if message.Render(English) != "missing" {
		t.Fatal("unknown key fallback")
	}
}
