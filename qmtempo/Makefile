# Builds qmtempo, the beat-tracking helper the box spawns once per track analysis.
#
# Compiles the qm-dsp sources directly rather than using the makefiles shipped in qm-dsp/build/,
# which hardcode x86 flags (-msse, -mfpmath=sse) that do not exist on the Pi's aarch64.
#
# Three things here are load-bearing:
#
#   -Dkiss_fft_scalar=double  qm-dsp calls KissFFT with doubles. Without it, FFT.cpp will not
#                             compile at all - it is the first thing to check if this breaks.
#
#   a static ARCHIVE, not a  qm-dsp's segmentation and key-detection modules reference LAPACK
#   direct link of all .cpp   symbols we have no use for. Linking from an archive pulls only the
#                             objects actually referenced, so those never need to resolve; compiling
#                             every source straight into the binary fails on them.
#
#   clapack/cblas excluded    same reason, one step earlier: they are big, they are only needed by
#                             that matrix code, and nothing on the beat-tracking path calls them.

PREFIX ?= /usr/local
CXX ?= g++
AR ?= ar
CXXFLAGS ?= -O2
QMFLAGS := -Iqm-dsp -Iqm-dsp/ext/kissfft -Iqm-dsp/ext/kissfft/tools -Dkiss_fft_scalar=double

BUILDDIR := .build
# `! -name ._*` is load-bearing, not tidiness. Releases are packaged on macOS, whose tar stores
# extended attributes as PAX headers; GNU tar on the Pi writes those back out as AppleDouble
# `._name` files sitting next to every real source. They are binary, and globbing them into the
# build makes g++ fail on "'Mac' does not name a type" - which is exactly how v0.5.1's on-box build
# failed. xwax never hit this because its Makefile lists sources explicitly rather than globbing.
SRCS := $(shell find qm-dsp/dsp qm-dsp/maths qm-dsp/base qm-dsp/ext/kissfft \
          \( -name '*.cpp' -o -name '*.c' \) ! -name '._*' 2>/dev/null \
          | grep -v -E 'test|example|clapack|cblas')
OBJS := $(patsubst %,$(BUILDDIR)/%.o,$(subst /,_,$(SRCS)))

all: qmtempo

$(BUILDDIR):
	@mkdir -p $(BUILDDIR)

$(BUILDDIR)/libqmdsp.a: | $(BUILDDIR)
	@for s in $(SRCS); do \
	  o="$(BUILDDIR)/$$(echo $$s | tr / _).o"; \
	  if [ ! -f "$$o" ] || [ "$$s" -nt "$$o" ]; then \
	    $(CXX) $(CXXFLAGS) $(QMFLAGS) -c "$$s" -o "$$o" || exit 1; \
	  fi; \
	done
	@$(AR) rcs $@ $(BUILDDIR)/*.o

qmtempo: qmtempo.cpp $(BUILDDIR)/libqmdsp.a
	$(CXX) $(CXXFLAGS) $(QMFLAGS) qmtempo.cpp $(BUILDDIR)/libqmdsp.a -o qmtempo -lm

install: qmtempo
	install -D -m 755 qmtempo $(DESTDIR)$(PREFIX)/bin/qmtempo

clean:
	rm -rf $(BUILDDIR) qmtempo

.PHONY: all install clean
