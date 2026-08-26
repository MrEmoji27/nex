package handle

import "golang.org/x/text/unicode/norm"

// nfkcForTest exposes step 2 in isolation so a test can assert the intermediate
// form named in the §2.1 vector table.
func nfkcForTest(s string) string { return norm.NFKC.String(s) }
