#!/usr/bin/env bash
# What is actually built on this machine?
#
# Run from the futurespark-backend root:   bash scripts/whats-deployed.sh
#
# Checks the COMPILED javascript, not the source — the source can be up to date
# while `npm run build` silently failed and pm2 keeps serving the old dist. Each
# marker is a string that only exists in the fixed version of that file.

cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0

check() {
  local label="$1" file="$2" marker="$3"
  if [ ! -f "$file" ]; then
    printf '  \033[33m?\033[0m  %-38s (not built: %s)\n' "$label" "$file"
    fail=$((fail + 1))
    return
  fi
  if grep -q -- "$marker" "$file"; then
    printf '  \033[32mYES\033[0m %-38s built %s\n' "$label" "$(date -r "$file" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"
    pass=$((pass + 1))
  else
    printf '  \033[31mNO\033[0m  %-38s built %s  <-- OLD CODE\n' "$label" "$(date -r "$file" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"
    fail=$((fail + 1))
  fi
}

echo
echo "CONSTANTS (shared by learning + auth)"
K=packages/constants/dist
check "frequency word cloud"          "$K/session-evidence.js" "buildWordCloud"
check "deck-sentence filter"          "$K/session-evidence.js" "isConceptLike"
check "phrases only when curated"     "$K/session-evidence.js" "phraseKeptWhole"
check "possessive + proper-noun drop" "$K/session-evidence.js" "midCap"
check "talk share without Not-avail"  "$K/session-report.js"   "talkValue"
check "summary heading renamed"       "$K/session-report.js"   "WORDS FROM THE SESSION"
check "answers capped at questions"   "$K/session-report.js"   "meaningfulOutOfQuestions"

echo
echo "LEARNING-SERVICE"
L=apps/learning-service/dist/modules/transcription
check "verified compression cache"    "$L/groq-transcription.service.js" "matchesSource"
check "unique transcription chunks"   "$L/groq-transcription.service.js" "runTag"

echo
echo "COMMUNICATION-SERVICE"
C=apps/communication-service/dist/modules/whatsapp
check "1024-char body budget"        "$C/report.service.js"  "fitBodyBudget"
check "template-vars missing warning" "$C/whatsapp.service.js" "warnedAboutDefaultTemplateVars"

echo
echo "INTEGRATION-SERVICE"
I=apps/integration-service/dist/modules
check "verified audio extraction"     "$I/shared/audio.js"                 "extractVerifiedAudio"
check "temp file then atomic rename"  "$I/shared/audio.js"                 "renameSync"
check "one shared extraction lock"    "apps/integration-service/dist/utils/concurrency.js" "audioExtractionsInFlight"
check "always re-extract missing audio" "$I/zoom/recording/recording.controller.js" "Always ask the extractor"
check "PROCESSING status written"     "$I/zoom/recording/recording.service.js" "'PROCESSING'"
check "transcription single-flight"    "$I/zoom/recording/recording.service.js" "zoom-transcribe"
check "zoom local-time display (IST)"  "$I/zoom/meetings/meetings.service.js" "zoomLocalTime"

echo
echo "AUTH-SERVICE"
A=apps/auth-service/dist/modules/report
check "approved report design"        "$A/report-design.js"    "drawSessionReport"
check "curriculum content in report"  "$A/report-curriculum.js" "gatherCurriculum"
check "14 template variables"         "$A/report.service.js"   "sessionNumberPadded"
check "slot 70min + editable end"     "$A/../user/user.service.js" "SLOT_DURATION_MINUTES"
check "slot conflict override"        "$A/../user/user.service.js" "allowConflict"
check "class conflict override"       "$A/../schedule/schedule.service.js" "allowConflict"
check "reschedule conflict override"  "$A/../schedule/schedule.service.js" "overrideConflicts"

echo
echo "INTEGRATION-SERVICE (meetings)"
check "zoom conflict override"        "$I/zoom/meetings/meetings.service.js" "allowConflict"
check "meet conflict override"        "$I/google/meetings/meetings.service.js" "allowConflict"

echo
echo "RUNNING PROCESSES"
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try {
        const list = JSON.parse(raw);
        if (!list.length) return console.log("  (pm2 reports no processes)");
        const seen = {};
        for (const p of list) {
          seen[p.name] = (seen[p.name] || 0) + 1;
          const started = p.pm2_env?.pm_uptime ? new Date(p.pm2_env.pm_uptime).toISOString().slice(0, 16).replace("T", " ") : "?";
          console.log(`  ${p.name.padEnd(26)} ${String(p.pm2_env?.status).padEnd(8)} restarted ${started}  script ${p.pm2_env?.pm_exec_path || "?"}`);
        }
        for (const [n, c] of Object.entries(seen)) {
          if (c > 1) console.log(`  !! ${n} is running ${c} times — a restart only hits one of them`);
        }
      } catch { console.log("  (could not read pm2 output)"); }
    });
  '
else
  echo "  (pm2 not on PATH)"
fi

echo
echo "----------------------------------------------------------------"
if [ "$fail" -eq 0 ]; then
  echo "All $pass checks present. If behaviour is still wrong, the build is"
  echo "current and the cause is elsewhere — restart, or something unrelated."
else
  echo "$fail of $((pass + fail)) markers MISSING. Those services are running old"
  echo "code. Rebuild them, watch for build errors, then restart:"
  echo "    cd apps/<service> && npm run build && pm2 restart <service> --update-env"
fi
echo
