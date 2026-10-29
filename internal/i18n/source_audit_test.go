package i18n

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

// Audit string literals, not comments: Go comments may remain in Chinese.
// Catalogs and the explicitly marked legacy helper table live in this package.
func TestNoCJKOutsideCatalogs(t *testing.T) {
	root := filepath.Join("..", "..")
	var violations []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if strings.HasPrefix(filepath.ToSlash(relative), "internal/i18n/") {
			return nil
		}
		positions := token.NewFileSet()
		file, err := parser.ParseFile(positions, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			value, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Errorf("%s: %v", positions.Position(literal.Pos()), err)
				return false
			}
			for _, r := range value {
				if unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana) {
					violations = append(violations, positions.Position(literal.Pos()).String())
					break
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		shown := violations
		if len(shown) > 20 {
			shown = shown[:20]
		}
		t.Fatalf("%d CJK string literals outside internal/i18n; first locations:\n%s", len(violations), strings.Join(shown, "\n"))
	}
}
