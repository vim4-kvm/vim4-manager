// Package i18n renders user-facing messages at the HTTP boundary. Errors keep
// English text for logs and retain their causes for errors.Is/errors.As.
package i18n

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type Locale string

const (
	English Locale = "en"
	Chinese Locale = "zh-CN"
)

type Message struct {
	Key  string
	Args map[string]any
}

func (m Message) Render(locale Locale) string {
	catalog := en
	if locale == Chinese {
		catalog = zhCN
	}
	text, ok := catalog[m.Key]
	if !ok {
		text = en[m.Key]
	}
	if text == "" {
		return m.Key
	}
	// Replace only tokens in the template, never recursively in argument values.
	var result strings.Builder
	for {
		before, rest, found := strings.Cut(text, "{")
		result.WriteString(before)
		if !found {
			break
		}
		name, after, closed := strings.Cut(rest, "}")
		if !closed {
			result.WriteString("{" + rest)
			break
		}
		if value, ok := m.Args[name]; ok {
			switch value := value.(type) {
			case Message:
				result.WriteString(value.Render(locale))
			case error:
				result.WriteString(RenderError(locale, value))
			default:
				result.WriteString(fmt.Sprint(value))
			}
		} else {
			result.WriteString("{" + name + "}")
		}
		text = after
	}
	return result.String()
}

type Error struct {
	Message Message
	Cause   error
}

func (e *Error) Error() string                  { return e.Message.Render(English) }
func (e *Error) Unwrap() error                  { return e.Cause }
func New(key string, args map[string]any) error { return &Error{Message: Message{key, args}} }
func Wrap(cause error, key string, args map[string]any) error {
	return &Error{Message: Message{key, args}, Cause: cause}
}
func RenderError(locale Locale, err error) string {
	if err == nil {
		return ""
	}
	var localized *Error
	if errors.As(err, &localized) {
		return localized.Message.Render(locale)
	}
	return HelperText(locale, err.Error())
}

// HelperText recognizes known legacy messages without rewriting unknown tool
// diagnostics or user-controlled filenames. English helper output is accepted
// too, so the manager can be upgraded before or after the helper package.
func HelperText(locale Locale, text string) string {
	message := strings.TrimPrefix(text, "sudo: ")
	if value, ok := helperPrefix(message); ok {
		return value.Render(locale)
	}
	if key, ok := legacyHelperKeys[message]; ok {
		return Message{Key: key}.Render(locale)
	}
	for _, key := range legacyHelperKeys {
		if en[key] == message {
			return Message{Key: key}.Render(locale)
		}
	}
	return text
}

// HelperError retains the process error as a cause for errors.Is/errors.As.
func HelperError(err error) error {
	if err == nil {
		return nil
	}
	message := strings.TrimPrefix(err.Error(), "sudo: ")
	if value, ok := helperPrefix(message); ok {
		return &Error{Message: value, Cause: err}
	}
	if key, ok := legacyHelperKeys[message]; ok {
		return Wrap(err, key, nil)
	}
	for _, key := range legacyHelperKeys {
		if en[key] == message {
			return Wrap(err, key, nil)
		}
	}
	return err
}

// RequestLocale is shared by the manager and gateway. Invalid cookies defer to
// Accept-Language; disabled (q=0) language ranges are never selected.
func RequestLocale(r *http.Request) Locale {
	if cookie, err := r.Cookie("vim4_lang"); err == nil {
		if cookie.Value == string(English) || cookie.Value == string(Chinese) {
			return Locale(cookie.Value)
		}
	}
	type preference struct {
		language string
		quality  float64
	}
	var preferences []preference
	for _, part := range strings.Split(r.Header.Get("Accept-Language"), ",") {
		fields := strings.Split(part, ";")
		quality := 1.0
		for _, parameter := range fields[1:] {
			if value, found := strings.CutPrefix(strings.TrimSpace(parameter), "q="); found {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || !(parsed >= 0 && parsed <= 1) {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		if quality > 0 {
			preferences = append(preferences, preference{strings.ToLower(strings.TrimSpace(fields[0])), quality})
		}
	}
	sort.SliceStable(preferences, func(i, j int) bool { return preferences[i].quality > preferences[j].quality })
	for _, item := range preferences {
		if strings.HasPrefix(item.language, "zh") {
			return Chinese
		}
		if item.language != "" {
			return English
		}
	}
	return English
}
