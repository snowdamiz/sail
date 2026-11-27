# Read named string fields from one object or each object in an array.
# Keep escapes intact so callers can validate the exact fields they consume.
function token() {
  sub(/^[[:space:]]+/, "", input)
  if (match(input, /^("(\\(["\\\/bfnrt]|u[[:xdigit:]][[:xdigit:]][[:xdigit:]][[:xdigit:]])|[^"\\[:cntrl:]])*"|-?(0|[1-9][0-9]*)(\.[0-9]+)?([Ee][+-]?[0-9]+)?|true|false|null|[][{}:,])/)) {
    next_token = substr(input, 1, RLENGTH)
    input = substr(input, RLENGTH + 1)
  } else if (input == "") {
    next_token = ""
  } else {
    exit 1
  }
}

function require(wanted) {
  if (next_token != wanted) exit 1
  token()
}

function object(capture,    key, index_in_row, strings, seen, i, row) {
  require("{")
  if (next_token != "}") {
    while (1) {
      if (substr(next_token, 1, 1) != "\"") exit 1
      key = next_token
      token()
      require(":")
      if (capture && key in columns) {
        index_in_row = columns[key]
        if (index_in_row in seen) exit 1
        seen[index_in_row] = 1
        if (substr(next_token, 1, 1) == "\"")
          strings[index_in_row] = substr(next_token, 2, length(next_token) - 2)
      }
      value()
      if (next_token != ",") break
      token()
    }
  }
  require("}")
  if (capture) {
    for (i = 1; i <= count; i++)
      row = row (i == 1 ? "" : "\t") (i in strings ? strings[i] : "")
    print row
  }
}

function array(capture) {
  require("[")
  if (next_token != "]") {
    while (1) {
      if (capture) object(1)
      else value()
      if (next_token != ",") break
      token()
    }
  }
  require("]")
}

function value() {
  if (next_token == "{") object(0)
  else if (next_token == "[") array(0)
  else if (next_token ~ /^["0-9-]/ || next_token ~ /^(true|false|null)$/) token()
  else exit 1
}

{ input = input $0 "\n" }
END {
  count = split(fields, names, " ")
  for (i = 1; i <= count; i++) columns["\"" names[i] "\""] = i
  token()
  if (rows) array(1)
  else object(1)
  if (next_token != "") exit 1
}
