import React, { useState } from "../../../frontend/node_modules/react/index.js";
import { createRoot } from "../../../frontend/node_modules/react-dom/client.js";

function Form() {
  const [values, setValues] = useState(Array(12).fill(""));
  const [country, setCountry] = useState("");
  const [saved, setSaved] = useState(false);
  return React.createElement(
    "form",
    {
      onSubmit: (event) => {
        event.preventDefault();
        setSaved(
          values.every((value, i) => value === "React " + i) &&
            country === "CN",
        );
      },
    },
    ...values.map((value, i) =>
      React.createElement(
        "label",
        { key: i },
        "React field " + i,
        React.createElement("input", {
          value,
          onChange: (event) => {
            const next = event.target.value;
            setValues((old) =>
              old.map((value, index) =>
                index === i
                  ? next === "normalize"
                    ? "NORMALIZED"
                    : next
                  : value,
              ),
            );
          },
        }),
      ),
    ),
    React.createElement(
      "label",
      null,
      "React country",
      React.createElement(
        "select",
        { value: country, onChange: (event) => setCountry(event.target.value) },
        React.createElement("option", { value: "" }, "Choose"),
        React.createElement("option", { value: "CN" }, "China"),
      ),
    ),
    React.createElement(
      "p",
      { role: "status" },
      values.every((value, i) => value === "React " + i) && country === "CN"
        ? "React state ready"
        : "React state incomplete",
    ),
    React.createElement("button", { type: "submit" }, "React submit"),
    React.createElement("p", null, saved ? "React saved" : "React unsaved"),
  );
}
createRoot(document.getElementById("root")).render(React.createElement(Form));
