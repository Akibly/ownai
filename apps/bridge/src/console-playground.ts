/** Runs inside the console closure, sharing its credential and clipboard helpers. */
export const PLAYGROUND_JS = `
  var testForm = document.getElementById("test-form");
  var testModel = document.getElementById("test-model");
  var testPrompt = document.getElementById("test-prompt");
  var testSend = document.getElementById("test-send");
  var testStop = document.getElementById("test-stop");
  var testClear = document.getElementById("test-clear");
  var testStatus = document.getElementById("test-status");
  var testResult = document.getElementById("test-result");
  var testResponse = document.getElementById("test-response");
  var testMeta = document.getElementById("test-meta");
  var testController = null;
  var testAvailable = testForm.getAttribute("data-available") === "true";

  function updateTest() {
    testSend.disabled = !testAvailable || !testPrompt.value.trim() || !!testController;
    var selected = testModel.selectedOptions[0];
    document.getElementById("test-usage").textContent = !testAvailable
      ? "An enabled connection and a gateway key are required. Set up a client above to get started."
      : selected && selected.getAttribute("data-kind") === "mock"
        ? "Local test model: echoes your prompt without using a provider account."
        : "Sends a real request. Provider usage limits and configured fallback rules apply.";
  }
  function testMessage(message, bad) {
    testStatus.textContent = message;
    testStatus.className = bad ? "test-status bad" : "test-status";
  }
  testPrompt.addEventListener("input", updateTest);
  testModel.addEventListener("change", updateTest);
  testClear.addEventListener("click", function () {
    if (testController) return;
    testPrompt.value = "";
    testResponse.textContent = "";
    testMeta.textContent = "";
    testResult.querySelector(".state").textContent = "";
    testResult.hidden = true;
    testMessage("Ready for a new request.", false);
    updateTest();
    testPrompt.focus();
  });
  testStop.addEventListener("click", function () {
    if (testController) testController.abort();
  });
  window.addEventListener("pagehide", function () {
    if (testController) testController.abort();
  });
  testPrompt.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing && !testSend.disabled) {
      event.preventDefault();
      testForm.requestSubmit();
    }
  });
  testForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (testSend.disabled || testController || !testForm.reportValidity()) return;
    var prompt = testPrompt.value.trim();
    var model = testModel.value;
    var controller = new AbortController();
    testController = controller;
    var signal = AbortSignal.any([controller.signal, AbortSignal.timeout(125000)]);
    var started = performance.now();
    var dispatched = false;
    var requestId = "";
    var actionStates = Array.from(document.querySelectorAll("[data-action]")).map(function (button) {
      var state = { button: button, disabled: button.disabled };
      button.disabled = true;
      return state;
    });
    testModel.disabled = true;
    testPrompt.readOnly = true;
    testClear.disabled = true;
    testStop.hidden = false;
    testResult.hidden = true;
    testResponse.textContent = "";
    testMeta.textContent = "";
    testResult.querySelector(".state").textContent = "";
    testForm.setAttribute("aria-busy", "true");
    testSend.textContent = "Sending…";
    updateTest();
    testMessage("Preparing request…", false);
    var timer = setInterval(function () {
      testMessage((dispatched ? "Waiting for response… " : "Preparing request… ") + Math.floor((performance.now() - started) / 1000) + "s", false);
    }, 1000);
    try {
      var key = await readKey(signal);
      signal.throwIfAborted();
      dispatched = true;
      var response = await fetch("/v1/chat/completions", {
        method: "POST", cache: "no-store", signal: signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], stream: false }),
      });
      requestId = response.headers.get("x-request-id") || "";
      var body;
      try { body = await response.json(); }
      catch (error) {
        signal.throwIfAborted();
        throw new Error("The bridge returned an unreadable response. Check that it is still running.");
      }
      if (!response.ok) {
        var failure = body && body.error || {};
        var recovery = {
          login_required: "Sign in with pnpm bridge login <connection-id>, then try again.",
          invalid_api_key: "Refresh the console to load the current gateway key.",
          policy_disabled: "Check that the connection is enabled and permitted to serve requests.",
          model_not_found: "Refresh the console to load the current connections.",
          quota_exhausted: "Wait for the provider allowance to reset or select another connection.",
          rate_limited: "Wait before sending another request.",
          queue_full: "The bridge is busy. Try again after the active requests finish.",
          provider_unavailable: "Check the provider connection and sign-in state.",
          timeout: "The provider did not finish in time. Check its state before sending again.",
        }[failure.code] || "Check the connection before trying again.";
        var retry = failure.bridge && failure.bridge.retry_after_s;
        throw new Error((failure.message || "Request failed (HTTP " + response.status + ").") + " " + recovery +
          (typeof retry === "number" ? " Retry after " + retry + " seconds." : ""));
      }
      var text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      if (typeof text !== "string") throw new Error("The bridge returned no text response. Check the selected connection.");
      // Provider output is text, never executable markup or unsanitized Markdown.
      testResponse.textContent = text || "(The provider returned an empty response.)";
      var bridge = body.bridge || {};
      var elapsed = ((performance.now() - started) / 1000).toFixed(1);
      testMeta.textContent = [bridge.provider, bridge.connection_id, bridge.provider_model, elapsed + "s",
        bridge.route_changed ? "Used an approved fallback" : "", requestId ? "Request " + requestId : ""].filter(Boolean).join(" · ");
      testResult.hidden = false;
      testMessage("Response received. Refresh activity to see its request metadata.", false);
    } catch (error) {
      if (signal.aborted) {
        testMessage(controller.signal.aborted
          ? (dispatched ? "Request stopped. The provider may already have used a turn." : "Request stopped before sending.")
          : "Request timed out. Check the provider before sending again; it may already have used a turn.", true);
      } else {
        testMessage((error && error.message || "Could not reach the bridge. Check that it is running.") +
          (requestId ? " Request ID: " + requestId : ""), true);
      }
    } finally {
      clearInterval(timer);
      testController = null;
      testModel.disabled = !testAvailable;
      testPrompt.readOnly = false;
      testClear.disabled = false;
      testStop.hidden = true;
      testSend.textContent = "Send request";
      testForm.setAttribute("aria-busy", "false");
      actionStates.forEach(function (state) { state.button.disabled = state.disabled; });
      updateTest();
    }
  });
  updateTest();
`;
