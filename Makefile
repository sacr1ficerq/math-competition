PYTHON ?= python3
VENV ?= .venv
VENV_PYTHON := $(VENV)/bin/python

.PHONY: help install run test

help:
	@printf '%s\n' 'make install  Create the virtual environment and install dependencies' 'make run      Start the app (port 9000 by default; see config.yaml)' 'make test     Run the backend tests'

$(VENV_PYTHON):
	$(PYTHON) -m venv "$(VENV)"

install: $(VENV_PYTHON)
	"$(VENV_PYTHON)" -m ensurepip --upgrade
	"$(VENV_PYTHON)" -m pip install -r requirements.txt

run: $(VENV_PYTHON)
	"$(VENV_PYTHON)" run.py

test: $(VENV_PYTHON)
	"$(VENV_PYTHON)" -m unittest discover -s tests -v
