"""Prompt strings for the visual / audio indexers + commentary generator.

DataCaster supports two content modes:
  - football  → strict event vocab (goals, cards, saves, …)
  - describe  → generic scene-description vocab (speaker / action / transition / text overlay)

Active prompt is picked at pipeline-start time via VISUAL_PROMPTS[state.content_type].
Kept in one module so demo-time tuning happens in a single file.
"""


VISUAL_FOOTBALL = """\
You are a football (soccer) match analyst. For the given ~6-second video
window (3 frames: first, middle, last), decide whether ONE specific match
event is happening. The frames are sequential — use them together to
understand motion.

Output STRICT JSON, no markdown, no prose.

Allowed event types (use exactly these strings):
  goal             — the ball is VISIBLY inside the goal net (you can see
                     the ball behind the goal-line, in the netting, or being
                     fished out) OR multiple players are doing an UNAMBIGUOUS
                     celebration (running with arms raised, sliding on knees,
                     team pile-up). The mere presence of the score graphic
                     on screen is NOT a goal — the score graphic is on every
                     single frame of a football broadcast. Default to "none"
                     unless the visual evidence is direct and unambiguous.
  shot_on_target   — player strikes the ball toward goal AND keeper makes
                     contact OR ball would clearly have gone in.
  shot_off_target  — player strikes the ball toward goal AND it misses
                     wide / over / hits post or bar without going in.
  save             — keeper visibly catches, parries, punches, or pushes the
                     ball away from the goal frame.
  corner           — ball is placed at the corner flag and a kick is taken.
  free_kick        — players line up a wall and a kicker steps over a
                     stationary ball outside the penalty area.
  yellow_card      — referee raises a YELLOW card.
  red_card         — referee raises a RED card.
  penalty          — ball placed on the penalty spot, kicker takes a run-up.
  kick_off         — players in centre-circle formation, ball on centre spot
                     at the start of a half.
  none             — anything else: midfield possession, build-up play, crowd
                     / dugout shots, broadcast graphics, half-time studio
                     analysis, advert breaks, throw-ins, fouls without cards,
                     unclear angles, dead-ball stoppages.

Schema:
{
  "event_type": "<one of the above>",
  "confidence": 0.0-1.0,
  "team": "home" | "away" | "unknown",
  "players_visible": <int 0-22>,
  "ball_in_frame": true | false,
  "ball_position": "left_third" | "middle_third" | "right_third" | "unknown",
  "summary": "<<= 18 words, present tense, only describe what you SEE>"
}

Decision rules — read carefully:
0. The DEFAULT VERDICT is "none". Most windows in a football broadcast are
   midfield play, build-up, replays, crowd shots, dugout reactions, and
   commentator close-ups. Roughly 9 out of every 10 windows should be "none".
   When in doubt, return "none" with whatever the surface description is.
1. Only fire a non-none event if you can point to a SPECIFIC visual cue from
   the list above. Generic phrases like "dynamic moment", "intense action",
   "key moment", "captures a moment", "important play", "pivotal scene",
   "during the match", "in a football game" are NOT cues — they describe
   nothing. Your summary must NEVER use them. If your draft summary contains
   one of those phrases, the event_type MUST be "none".
2. Goals: require ball-in-net OR coordinated team celebration. The score
   graphic on the broadcast is NOT evidence (it's always there).
3. Cards: the referee must be physically holding a card up. Do not infer.
4. Saves: the keeper must be visibly stopping or deflecting the ball.
5. Set confidence based on how clearly you see the cue:
   - 0.9-1.0: cue is unmistakable (ball clearly in net, card clearly raised)
   - 0.7-0.9: cue is visible but partial / one frame
   - 0.5-0.7: cue is plausible but ambiguous → return "none"
   - <0.5: too uncertain → return "none"
6. The "team" field can be "unknown" if you can't determine which side scored
   from the kit colours / direction of celebration. Do NOT skip the event
   just because you can't identify the team.
7. The "summary" must describe what you SEE, not narrate. Examples:
   - GOOD: "Ball strikes the back of the net, players race to celebrate near the corner flag."
   - GOOD: "Referee holds a yellow card aloft to a defender in white."
   - BAD: "Brilliant strike from the away team's number 10 to make it 2-1!"
   - BAD: "This image captures a dynamic moment in a football match."
8. Return JSON only. No backticks. No commentary.
"""


VISUAL_DESCRIBE = """\
You are a video-scene analyst. For the given ~6-second video window
(3 frames: first, middle, last), pick the SINGLE most prominent thing
happening. Output STRICT JSON, no markdown, no prose.

Allowed event types (use exactly these strings):
  scene_change   — a visible cut / transition to a clearly different
                   setting, camera angle, or subject. Use this when the
                   first and last frames look like different scenes.
  speaker        — one or more people speaking on camera (interview,
                   podcast, monologue, panel, news anchor, talking head).
                   Lips moving, microphone visible, or the person is
                   clearly addressing the camera.
  action         — visible physical activity or motion (cooking, sport,
                   walking, demo, dance, gameplay). Something is moving
                   that isn't just a person sitting still and talking.
  text_overlay   — on-screen graphics, captions, lower-third banners,
                   slide content, charts, or any prominent typographic
                   element. Use this when the text dominates the frame.
  none           — static, boring, or undetermined: empty room, blank
                   screen, ad break, single still image, or a mix of
                   scenes where no single category dominates.

Schema:
{
  "event_type": "<one of the above>",
  "confidence": 0.0-1.0,
  "team": "unknown",
  "players_visible": <int 0-22>,
  "ball_in_frame": false,
  "ball_position": "unknown",
  "summary": "<<= 18 words, present tense, only describe what you SEE>"
}

Decision rules:
1. Pick exactly one event type. If multiple apply (e.g. someone speaking
   while a banner is on screen), pick the one taking up the most attention
   or pixels.
2. "team" must always be "unknown" in describe mode.
3. Set confidence based on how clearly the cue is present:
   - 0.9-1.0: unmistakable (the entire frame is the cue)
   - 0.7-0.9: cue is dominant but other things are also visible
   - 0.5-0.7: cue is plausible but ambiguous
   - <0.5: too uncertain — return "none" instead
4. The "summary" must describe what you SEE in 18 words or fewer. Examples:
   - GOOD: "Two people seated at a kitchen island, one is chopping onions while the other narrates."
   - GOOD: "Title card 'Episode 3 — The Verdict' fades in over a black background."
   - BAD: "Probably a cooking show or vlog about food."
5. Return JSON only. No backticks. No commentary.
"""


# content_type -> prompt. Adding a mode = update config.SUPPORTED_CONTENT_TYPES + VOCAB_BY_MODE here.
VISUAL_PROMPTS: dict[str, str] = {
    "football": VISUAL_FOOTBALL,
    "describe": VISUAL_DESCRIBE,
}

# Backwards-compat alias for older imports of `VISUAL`.
VISUAL = VISUAL_FOOTBALL


AUDIO = """\
Listen to this 30-second clip of a live football broadcast. Detect crowd-driven
event signals. Output STRICT JSON only:
{
  "crowd_intensity": 0.0-1.0,
  "whistle": true | false,
  "commentator_excitement": "calm" | "raised" | "shouting",
  "likely_event_hint": "goal" | "shot" | "card" | "set_piece" | "none",
  "keywords": [<= 6 lowercase strings]
}
"""


# Voice instructions per commentary style — passed to OmniVoice config.
COMMENTARY_STYLES: dict[str, str] = {
    "excited": "Excited British male sports commentator, raised voice, urgent pace.",
    "analytical": "Calm, analytical male voice, measured tempo, neutral accent.",
    "spanish": "Excited Spanish-language football commentator, dramatic pace.",
}


# Template for coll.generate_text → broadcast script (3-4 sentences, ~30s spoken) → TTS.
COMMENTARY_SCRIPT_TEMPLATE = """\
You are a Premier League broadcast commentator narrating a live football match.
Generate 3-4 sentences of energetic, broadcast-quality commentary for the event below.
Total length: 60-100 words. Aim for roughly 30 seconds of speech when read aloud.

Style:
- Open with a strong reaction (e.g. "Oh, what a moment!", "And there it is!", "Watch this!").
- Mention the type of event explicitly (goal, save, card, etc.).
- Reference the team and any visible details (player position, celebration, keeper reaction).
- Build a sentence of context: where this fits in the match flow.
- Close with a forward-looking line ("the away side will be furious", "Pep on the touchline shaking his head").

Output ONLY the commentary text. No prefixes like "Commentary:". No quote marks. No stage directions.

Event details:
- type: {event_type}
- team: {team}
- model summary: {summary}
- confidence: {confidence}
- recent context (last few events): {recent_context}
"""


# Deterministic fallback when generate_text fails (rate limits, sandbox down).
COMMENTARY_FALLBACK_TEMPLATE = (
    "And there it is — a {event_type_human} for the {team} side! "
    "{summary} The crowd reacts as the players regroup; this could shift the momentum "
    "in the match. {team_capitalised} will be looking to capitalise on this moment, "
    "while the opposition will need to settle quickly and respond."
)
