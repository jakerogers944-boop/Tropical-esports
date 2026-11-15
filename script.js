const form = document.querySelector("#application-form");
const result = document.querySelector("#ticket-result");
const formError = document.querySelector("#form-error");
const gameSelect = form.querySelector('[name="game"]');
const gamerTagLabel = form.querySelector("[data-gamertag-label]");
const gamerTagInput = form.querySelector('[name="gamertag"]');
const gamerTagHint = form.querySelector("[data-gamertag-hint]");
const lookupForm = document.querySelector("#ticket-lookup-form");
const lookupResult = document.querySelector("#ticket-lookup-result");

gameSelect.addEventListener("change", updateGamerTagPrompt);
form.addEventListener("reset", updateGamerTagPrompt);
updateGamerTagPrompt();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  formError.hidden = true;
  const formData = new FormData(form);
  const applicant = {
    name: formData.get("name").trim(),
    email: formData.get("email").trim(),
    gamertag: formData.get("gamertag").trim(),
    game: formData.get("game"),
    platform: formData.get("platform"),
    discord: formData.get("discord").trim(),
    about: formData.get("about").trim(),
    consent: formData.get("consent") === "on",
  };

  const submitButton = form.querySelector("[type=submit]");
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(applicant),
    });
    const ticket = await response.json();
    if (!response.ok) throw new Error(ticket.error || "Your ticket could not be submitted.");

    result.innerHTML = `
      <p class="ticket-success"><span class="live-dot"></span> TICKET CREATED</p>
      <h4>You’re on the board, ${escapeHTML(applicant.name)}.</h4>
      <p>Your tryout ticket is ready. Hang on to this number for your records.</p>
      <div class="ticket-number"><small>YOUR TICKET ID</small><strong>${escapeHTML(ticket.ticketId)}</strong></div>
      <div class="ticket-actions">
        <button class="button button-primary" type="button" data-copy-ticket> COPY TICKET ID <span aria-hidden="true">↗</span></button>
        <a class="button button-secondary" href="#check-ticket">CHECK STATUS</a>
        <button class="button button-secondary" type="button" data-new-application>NEW APPLICATION</button>
      </div>
      <p class="ticket-disclaimer">Your application is stored on the Tropical Esports server for review.</p>
    `;
    form.hidden = true;
    result.hidden = false;
    result.querySelector("[data-copy-ticket]").addEventListener("click", async (copyEvent) => {
      const copyButton = copyEvent.currentTarget;
      try {
        await navigator.clipboard.writeText(ticket.ticketId);
        copyButton.innerHTML = "COPIED! <span aria-hidden=\"true\">✓</span>";
      } catch {
        copyButton.textContent = "COPY FAILED — SELECT ID ABOVE";
      }
    });
    result.querySelector("[data-new-application]").addEventListener("click", () => {
      result.hidden = true;
      form.reset();
      form.hidden = false;
      updateGamerTagPrompt();
      form.querySelector("input").focus();
    });
  } catch (error) {
    formError.textContent = error.message || "Unable to submit your ticket. Please try again.";
    formError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!lookupForm.reportValidity()) return;

  lookupResult.hidden = true;
  const submitButton = lookupForm.querySelector("[type=submit]");
  const formData = new FormData(lookupForm);
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/tickets/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email").trim(),
        ticketId: formData.get("ticketId").trim(),
      }),
    });
    const ticket = await response.json();
    if (!response.ok) throw new Error(ticket.error || "Could not find that ticket.");
    showTicketStatus(ticket);
  } catch (error) {
    lookupResult.replaceChildren();
    const message = document.createElement("p");
    message.className = "lookup-error";
    message.textContent = error.message || "Could not check your ticket. Please try again.";
    lookupResult.append(message);
    lookupResult.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

function updateGamerTagPrompt() {
  if (gameSelect.value === "Fortnite") {
    gamerTagLabel.firstChild.textContent = "Fortnite / Epic username ";
    gamerTagInput.placeholder = "Your Epic display name";
    gamerTagHint.textContent = "Use your Epic display name so the team can add you in Fortnite.";
  } else if (gameSelect.value === "Siege") {
    gamerTagLabel.firstChild.textContent = "Siege / Ubisoft username ";
    gamerTagInput.placeholder = "Your Ubisoft Connect username";
    gamerTagHint.textContent = "Use your Ubisoft Connect username so the team can add you in Siege.";
  } else {
    gamerTagLabel.firstChild.textContent = "In-game username ";
    gamerTagInput.placeholder = "Username the team can add";
    gamerTagHint.textContent = "Enter the username the team should add for a tryout.";
  }
}

function showTicketStatus(ticket) {
  lookupResult.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = ticket.ticketId;
  const review = document.createElement("p");
  review.className = "lookup-review-status";
  review.textContent = ticket.checked ? "CHECKED BY THE TEAM" : "WAITING FOR TEAM REVIEW";
  const schedule = document.createElement("p");
  schedule.className = "lookup-schedule";
  schedule.textContent = ticket.scheduledAt
    ? `Tryout scheduled for ${formatSchedule(ticket.scheduledAt)}`
    : "No tryout date or time has been set yet.";
  lookupResult.append(review, heading, schedule);
  lookupResult.hidden = false;
}

function formatSchedule(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date).replace(", ", " at ");
}

function escapeHTML(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}
