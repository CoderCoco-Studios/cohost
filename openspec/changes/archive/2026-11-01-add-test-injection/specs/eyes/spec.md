## ADDED Requirements

### Requirement: Injected images
The system SHALL subscribe with consumer group `eyes` to `inject.request` and, for `target: "eyes"` and `kind: "image"`, fetch `url`, base64-encode the bytes, call the vision model through the same describer as `look()` with an empty previous description, and publish `vision.summary {text, changed: true, injected: true, remember}` followed by `inject.result {id, ok:true, detail:text}`. A reply that is empty or `SAME` SHALL yield `inject.result {ok:false}` and no `vision.summary`. Injection MUST NOT read or modify the previous description used by `look()`, MUST NOT require OBS, and MUST work when `vision.enabled` is false provided the vision model backend is reachable; otherwise it SHALL publish `inject.result {ok:false, detail}` with the error. The service MUST only fetch URLs beginning with `urls.dashboard()` + `/uploads/`; any other URL, a fetch failure or a request older than 60 s SHALL yield `inject.result {ok:false}` without calling the model.

#### Scenario: Image described
- **WHEN** an image request arrives and the model returns "a menu screen"
- **THEN** `vision.summary {text:"a menu screen", changed:true, injected:true, remember:false}` and `inject.result {ok:true}` are published

#### Scenario: Vision disabled, model reachable
- **WHEN** `vision.enabled` is false and the vision model answers
- **THEN** the summary is published and no OBS connection is attempted

#### Scenario: Model unreachable
- **WHEN** the vision model call throws "vision model 503"
- **THEN** `inject.result {ok:false, detail}` mentions the error and no `vision.summary` is published

#### Scenario: No change tracking side effect
- **WHEN** an image is injected between two `look()` calls
- **THEN** the second `look()` still receives the description from the first `look()` as previous

#### Scenario: Foreign URL
- **WHEN** `url` points outside `<DASHBOARD_URL>/uploads/`
- **THEN** nothing is fetched and `inject.result {ok:false}` is published

#### Scenario: Not for eyes
- **WHEN** `target` is `ears`
- **THEN** eyes publishes nothing
