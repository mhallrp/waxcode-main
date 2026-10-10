/*
 * qmtempo - tempo and first-beat from stdin, using the Queen Mary DSP beat tracker.
 *
 * Reads raw mono float32 samples on stdin (what `ffmpeg -f f32le -ac 1` already produces for the
 * rest of this project) and prints one line: "<bpm> <firstBeatSeconds> <beatCount>".
 *
 * A separate process rather than a Node addon on purpose: it matches how the box already treats
 * ffmpeg, keeps the GPL library at arm's length from the server code, and means the analysis can
 * be nice'd and killed like any other spawned job.
 *
 * Usage: qmtempo <sampleRate>
 */
#include <dsp/onsets/DetectionFunction.h>
#include <dsp/tempotracking/TempoTrackV2.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <algorithm>
#include <cmath>
#include <string>

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: qmtempo <sampleRate>\n"); return 2; }
    const double sampleRate = atof(argv[1]);

    // Same geometry the Vamp plugin uses: ~11.61ms hop, 50% overlap.
    const double stepSecs = 0.01161;
    const size_t stepSize = (size_t)(sampleRate * stepSecs + 0.0001);
    const size_t blockSize = stepSize * 2;

    std::vector<float> in;
    {
        std::vector<float> buf(65536);
        size_t n;
        while ((n = fread(buf.data(), sizeof(float), buf.size(), stdin)) > 0)
            in.insert(in.end(), buf.begin(), buf.begin() + n);
    }
    if (in.size() < blockSize * 8) { fprintf(stderr, "too short\n"); return 1; }

    DFConfig cfg;
    cfg.DFType = DF_COMPLEXSD;      // the plugin's default, and the best general-purpose choice
    cfg.stepSize = stepSize;
    cfg.frameLength = blockSize;
    cfg.dbRise = 3;
    cfg.adaptiveWhitening = false;
    cfg.whiteningRelaxCoeff = -1;
    cfg.whiteningFloor = -1;

    DetectionFunction df(cfg);
    std::vector<double> dfOut;
    std::vector<double> frame(blockSize);
    for (size_t pos = 0; pos + blockSize <= in.size(); pos += stepSize) {
        for (size_t i = 0; i < blockSize; i++) frame[i] = in[pos + i];
        dfOut.push_back(df.processTimeDomain(frame.data()));
    }
    if (dfOut.size() < 16) { fprintf(stderr, "too few frames\n"); return 1; }

    // Discard the first two, as the plugin does - they carry filter start-up, not music.
    std::vector<double> dfv, beatPeriod;
    for (size_t i = 2; i < dfOut.size(); i++) { dfv.push_back(dfOut[i]); beatPeriod.push_back(0.0); }

    std::vector<double> tempi, beats;
    TempoTrackV2 tt(sampleRate, stepSize);
    tt.calculateBeatPeriod(dfv, beatPeriod, tempi);
    tt.calculateBeats(dfv, beatPeriod, beats);
    if (beats.size() < 4) { fprintf(stderr, "no beats\n"); return 1; }

    /*
     * Tempo from the MEDIAN inter-beat interval, not the mean and not the tracker's own per-frame
     * tempo estimate: the tracker is allowed to follow tempo changes, so a handful of frames where
     * it slipped should not move the one number this project wants for a fixed grid.
     */
    std::vector<double> iois;
    for (size_t i = 1; i < beats.size(); i++)
        iois.push_back((beats[i] - beats[i-1]) * stepSize / sampleRate);
    std::sort(iois.begin(), iois.end());
    const double medianIoi = iois[iois.size() / 2];
    if (medianIoi <= 0) return 1;

    /*
     * Long-baseline tempo: how far apart the FIRST and LAST on-grid beats are, divided by how many
     * beats separate them. One measurement over minutes rather than an average of many short ones,
     * so its precision improves with track length instead of staying at the resolution of a single
     * inter-beat gap.
     *
     * Only beats that sit on the grid implied by the median are counted, so a single dropped or
     * spurious beat shifts nothing - it is excluded rather than absorbed into the count, which is
     * what would otherwise put the whole fit out by a beat.
     */
    std::vector<double> beatSecs;
    for (size_t i = 0; i < beats.size(); i++) beatSecs.push_back(beats[i] * stepSize / sampleRate);

    double first = beatSecs[0], last = first;
    long totalBeats = 0;
    for (size_t i = 1; i < beatSecs.size(); i++) {
        double n = (beatSecs[i] - last) / medianIoi;
        long rounded = lround(n);
        if (rounded >= 1 && fabs(n - rounded) < 0.15) { totalBeats += rounded; last = beatSecs[i]; }
    }
    double longBaseline = (totalBeats >= 8) ? 60.0 / ((last - first) / totalBeats) : 60.0 / medianIoi;

    // median-derived, long-baseline, first beat, beat count, beats spanned by the fit
    printf("%.4f %.4f %.4f %zu %ld\n", 60.0 / medianIoi, longBaseline, beatSecs[0], beats.size(), totalBeats);

    /*
     * --beats also dumps every beat position the tracker found.
     *
     * A loop's length is currently computed as beats x 60/bpm - a straight line through one tempo
     * number - so any error in that number is a constant tempo difference against the other deck,
     * which is what makes a long loop drift out of phase. Real beat positions let a loop be set
     * from beat[k] to beat[k+n] instead: measured, and immune to a track that does not hold a
     * perfectly constant tempo.
     */
    if (argc > 2 && std::string(argv[2]) == "--beats") {
        for (size_t i = 0; i < beatSecs.size(); i++) printf("%.4f\n", beatSecs[i]);
    }
    return 0;
}
