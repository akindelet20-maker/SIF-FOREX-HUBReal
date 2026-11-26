#!/usr/bin/env python3
"""Validate Academy JSON sources and build a lightweight static lesson manifest."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "academy-content"
OUTPUT = ROOT / "academy-data.js"
EXPECTED_LESSONS = [9, 8, 9, 13, 10, 10, 12, 12, 13, 14, 13, 14, 13, 12, 11, 11, 11, 11]
REQUIRED_LESSON_FIELDS = {
    "id", "title", "intro", "objectives", "explanation", "steps", "example",
    "remember", "mistakes", "summary", "visual", "quiz",
}
ALLOWED_VISUALS = {
    "candles", "trend", "levels", "structure", "supplydemand", "liquidity", "fvg", "orderblock",
    "risk", "entry", "session", "pairs", "macro", "platform", "psychology",
    "broker", "journal", "propfirm", "routine", "timeline",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def main() -> None:
    manifest: list[dict] = []
    seen_ids: set[str] = set()
    total_quizzes = 0
    total_lessons = 0

    for module_id, expected_count in enumerate(EXPECTED_LESSONS, 1):
        path = CONTENT / f"module-{module_id:02d}.json"
        require(path.is_file(), f"Missing module source: {path.relative_to(ROOT)}")
        module = json.loads(path.read_text(encoding="utf-8"))
        require(module.get("id") == module_id, f"Wrong module id in {path.name}")
        require(isinstance(module.get("title"), str) and module["title"].strip(), f"Missing module title in {path.name}")
        require(isinstance(module.get("description"), str) and module["description"].strip(), f"Missing module description in {path.name}")
        lessons = module.get("lessons")
        require(isinstance(lessons, list) and len(lessons) == expected_count,
                f"{path.name}: expected {expected_count} lessons, got {len(lessons) if isinstance(lessons, list) else 'invalid'}")

        for lesson_index, lesson in enumerate(lessons, 1):
            label = f"{path.name} lesson {lesson_index}"
            require(isinstance(lesson, dict), f"{label} must be an object")
            missing = REQUIRED_LESSON_FIELDS - lesson.keys()
            require(not missing, f"{label} missing fields: {sorted(missing)}")
            lesson_id = str(lesson["id"])
            require(lesson_id not in seen_ids, f"Duplicate lesson id: {lesson_id}")
            seen_ids.add(lesson_id)
            require(lesson_id == f"m{module_id}-l{lesson_index}", f"Unexpected lesson id {lesson_id}; expected m{module_id}-l{lesson_index}")
            for field in ("intro", "example", "summary"):
                require(isinstance(lesson.get(field), str) and lesson[field].strip(), f"{label}: empty {field}")
            for field in ("objectives", "explanation", "steps", "remember", "mistakes"):
                value = lesson.get(field)
                require(isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value), f"{label}: invalid {field}")
            explanation_words = len(" ".join(lesson["explanation"]).split())
            require(explanation_words >= 90, f"{label}: explanation is only {explanation_words} words")
            visual = lesson.get("visual")
            require(isinstance(visual, dict) and visual.get("type") in ALLOWED_VISUALS and isinstance(visual.get("caption"), str) and visual["caption"].strip(), f"{label}: invalid visual type/caption")
            quiz = lesson.get("quiz")
            require(isinstance(quiz, list) and len(quiz) == 5, f"{label}: expected exactly 5 quiz questions")
            for question_index, question in enumerate(quiz, 1):
                qlabel = f"{label} question {question_index}"
                require(isinstance(question, dict), f"{qlabel} must be an object")
                require(isinstance(question.get("question"), str) and question["question"].strip(), f"{qlabel}: missing question")
                options = question.get("options")
                require(isinstance(options, list) and len(options) == 4 and all(isinstance(option, str) and option.strip() for option in options), f"{qlabel}: expected four non-empty options")
                require(isinstance(question.get("correct"), int) and 0 <= question["correct"] < 4, f"{qlabel}: correct must be an option index from 0 to 3")
                require(isinstance(question.get("explanation"), str) and question["explanation"].strip(), f"{qlabel}: missing answer explanation")
                total_quizzes += 1
            total_lessons += 1
        manifest.append({
            "id": module_id,
            "title": module["title"],
            "description": module["description"],
            "lessons": [{"id": lesson["id"], "title": lesson["title"]} for lesson in lessons],
        })

    require(total_lessons == sum(EXPECTED_LESSONS), "Unexpected total lesson count")
    source = "// Generated from academy-content/module-*.json by scripts/build-academy-data.py. Do not edit by hand.\n"
    source += "export const ACADEMY_MODULES = " + json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + ";\n"
    OUTPUT.write_text(source, encoding="utf-8")
    print(f"Validated {len(manifest)} modules, {total_lessons} lessons, and {total_quizzes} quiz questions.")
    print(f"Wrote compact {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes). Detailed module JSON loads only on demand.")


if __name__ == "__main__":
    main()
