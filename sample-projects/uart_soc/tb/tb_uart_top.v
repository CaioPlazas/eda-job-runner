// Self-checking testbench for the UART subsystem.
//
// Strategy: loop the serial TX pin straight back into the RX pin, push a stream
// of bytes into the TX FIFO, and check that exactly those bytes come back out
// of the RX FIFO in order. Covers a directed pattern (walking values, corner
// bytes) and a randomized burst. Prints a clear PASS/FAIL summary and sets a
// non-zero-ish marker in the log so pass/fail is unambiguous.
`timescale 1ns/1ps
module tb_uart_top;
    localparam CLK_PER_BIT = 16;
    localparam FIFO_DEPTH  = 16;

    reg        clk = 1'b0;
    reg        rst_n = 1'b0;

    reg        wr_en = 1'b0;
    reg  [7:0] wr_data = 8'd0;
    wire       tx_full;

    reg        rd_en = 1'b0;
    wire [7:0] rd_data;
    wire       rx_empty;

    wire       serial;       // tx pin looped back to rx pin
    wire       rx_frame_err;

    uart_top #(.CLK_PER_BIT(CLK_PER_BIT), .FIFO_DEPTH(FIFO_DEPTH)) dut (
        .clk(clk), .rst_n(rst_n),
        .wr_en(wr_en), .wr_data(wr_data), .tx_full(tx_full),
        .rd_en(rd_en), .rd_data(rd_data), .rx_empty(rx_empty),
        .uart_tx_pin(serial), .uart_rx_pin(serial),
        .rx_frame_err(rx_frame_err)
    );

    // 100 MHz clock
    always #5 clk = ~clk;

    // Scoreboard: a queue of expected bytes, checked as they emerge from RX.
    reg [7:0] expected [0:1023];
    integer   exp_wr = 0;
    integer   exp_rd = 0;
    integer   errors = 0;
    integer   checked = 0;

    // Push one byte into the TX FIFO and record it as expected.
    task send_byte(input [7:0] b);
        begin
            @(posedge clk);
            while (tx_full) @(posedge clk);
            wr_data <= b;
            wr_en   <= 1'b1;
            @(posedge clk);
            wr_en   <= 1'b0;
            expected[exp_wr] = b;
            exp_wr = exp_wr + 1;
        end
    endtask

    // Continuously drain the RX FIFO and compare against the scoreboard. The
    // FIFO is first-word fall-through: rd_data already shows the head, so we
    // sample it in the same cycle we assert rd_en (which advances to the next).
    task drain_and_check;
        begin
            @(posedge clk);
            if (!rx_empty) begin
                if (rd_data !== expected[exp_rd]) begin
                    $display("FAIL: byte %0d mismatch: got 0x%02x expected 0x%02x",
                             exp_rd, rd_data, expected[exp_rd]);
                    errors = errors + 1;
                end
                rd_en <= 1'b1;
                @(posedge clk);
                rd_en <= 1'b0;
                checked = checked + 1;
                exp_rd = exp_rd + 1;
            end
        end
    endtask

    integer i;
    integer seed = 32'hC0FFEE;
    integer guard;
    reg     sending_done = 1'b0;

    // Stimulus process: push the full byte stream into the TX FIFO.
    initial begin
        // Reset
        rst_n = 1'b0;
        repeat (8) @(posedge clk);
        rst_n = 1'b1;
        repeat (4) @(posedge clk);

        // --- Directed: corner bytes + a walking-one pattern ---
        send_byte(8'h00);
        send_byte(8'hFF);
        send_byte(8'hA5);
        send_byte(8'h5A);
        for (i = 0; i < 8; i = i + 1)
            send_byte(8'h01 << i);

        // --- Randomized burst ---
        for (i = 0; i < 24; i = i + 1)
            send_byte($random(seed));

        sending_done = 1'b1;
    end

    // Checker process: drain+check concurrently so the 16-deep RX FIFO never
    // overflows while the stimulus process is still feeding the TX side.
    initial begin
        guard = 0;
        // Run until sending is finished AND every sent byte has been checked.
        while ((!sending_done || exp_rd < exp_wr) && guard < 4_000_000) begin
            drain_and_check;
            guard = guard + 1;
        end

        // --- Report ---
        $display("----------------------------------------");
        $display("UART loopback test: %0d bytes checked, %0d error(s)", checked, errors);
        if (rx_frame_err)
            $display("NOTE: rx_frame_err asserted at least once");
        if (errors == 0 && checked == exp_wr && checked > 0) begin
            $display("** TEST PASSED **");
        end else begin
            $display("** TEST FAILED ** (checked=%0d expected=%0d errors=%0d)",
                     checked, exp_wr, errors);
        end
        $display("----------------------------------------");
        $finish;
    end

    // Global watchdog
    initial begin
        #50_000_000;
        $display("** TEST FAILED ** watchdog timeout");
        $finish;
    end
endmodule
